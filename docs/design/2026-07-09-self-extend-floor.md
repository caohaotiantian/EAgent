# Design: `self-extend-floor` — a model-capability floor for self-extension

Task slug: `2026-07-09-self-extend-floor`
Wave 2 of "absorb harness-engineering lessons into EAgent".

## 1. Background and Purpose

The verified STOP result (Zelikman et al., arXiv 2310.02304) — surfaced in the
harness-engineering analysis (`analysis/harness-engineering-for-self-improvement.md`
§5.1) — is that scaffold-level self-improvement **only bootstrapped with a
GPT-4-class base model**; weaker models (GPT-3.5, Mixtral) could not. The
engineering lesson: a self-modifying loop should assume a capable base and
**refuse rather than loop uselessly (or dangerously) on a weak one**.

EAgent's self-modification surface is well-gated in every respect *except* model
competence: `self.ts` (`write_extension`, `reload_extension`) and
`self-improve.ts` (`propose_improvement`, `adopt_improvement`) all require the
`self:extend` capability (ask/deny), a static veto, sandboxed eval, and
fail-closed human review — but **nothing anywhere keys on which model is driving
the self-extension** (confirmed: no model-capability gate exists in the repo).
A weak or cheap model, once `self:extend` is granted, can drive extension
authoring/adoption exactly as a frontier model can.

This wave adds the missing floor: an opt-in guard that blocks `self:extend`-gated
tool calls when the acting model is not on a configured allowlist of
capable-model patterns. If we do not, the self-improvement stack has no
competence-aware safety control, contradicting the STOP lesson it is meant to
embody.

## 2. Deliverables

- [ ] `src/extensions/self-extend-floor.ts` — a single-file extension, default-export `activate(e)`, that:
  - [ ] rides the `beforeToolCall` filter hook (mirroring `risk-guard.ts`);
  - [ ] is **capability-scoped**: it acts only on a call whose registered tool declares `self:extend` (looked up via `e.agent.tools.get(call.name)?.capabilities`), so it covers `self.ts` + `self-improve.ts` **and any future `self:extend` tool** without naming them;
  - [ ] blocks the call (`{ block: true, reason }`) when the acting model (`e.agent.model`) matches **none** of the configured allowlist patterns; passes it through otherwise;
  - [ ] is **inert by default** — an empty/unset allowlist performs zero gating (byte-identical to today); activated only by configuring the allowlist;
  - [ ] honors a hard kill switch `EAGENT_SELF_EXTEND_FLOOR=off` (guard fully inactive);
  - [ ] reads the allowlist from `e.config` (key `selfExtendFloor.models`, comma-separated model substrings, case-insensitive);
  - [ ] emits one `e.log.warn` line when it blocks (naming the tool, the acting model, and the floor) so an operator can see the floor firing — the observability affordance in lieu of a dedicated command.
- [ ] `src/extensions/self-extend-floor.ts` appended to `BUILTIN_EXTENSIONS` in `src/host.ts` after `self-improve`.
- [ ] `test/self-extend-floor.test.ts` — offline `node:test` coverage for every Acceptance Criterion in §7.
- [ ] One-line row appended to the extension table in `README.md`; one-line CHANGELOG entry.

## 3. Scope Boundary (NOT in scope)

- **No hardcoded model list.** The allowlist is config-supplied. The extension ships with **no** baked-in "known-capable" models (a baked list is exactly the stale-defaults failure mode the analysis warns about — models change monthly).
- **Only `self:extend` is gated.** The guard does not floor other high-authority capabilities (`code:exec`, `pkg:install`, `shell:exec`). Extending the gated-capability set is out of scope.
- **No sub-agent per-agent model resolution.** The guard reads `e.agent.model` (the root agent's model), mirroring `risk-guard.ts:166`. A spawned sub-agent with a model override is not separately resolved here; a `currentActingAgent()`-aware floor is a possible follow-up, explicitly deferred.
- **No change to `self.ts` / `self-improve.ts`.** The floor is a cross-cutting guard extension; the gated extensions are untouched.
- **No dedicated command.** The floor is configured and inspected through the existing centralized `/config` facility (`selfExtendFloor.models`) and the `EAGENT_SELF_EXTEND_FLOOR` env kill — no new slash command (Simplicity First).
- **No kernel edits.** `src/kernel/*` is untouched.
- **The guard does not weaken any existing gate.** It only *adds* a veto; `self:extend`, the static veto, sandboxed eval, and human review all still apply unchanged.

## 4. Key Design Decisions

### Decision 1 — New guard extension vs. editing `self.ts` / `self-improve.ts`
- **Problem:** where does the floor live?
- **Options:** (a) add a model check inside each of the four self:extend tools; (b) one cross-cutting `beforeToolCall` guard extension.
- **Choice: (b).** One capability-scoped guard covers all current `self:extend` tools across two files **and any future one**, with a single tested code path. It mirrors the established `risk-guard.ts` pattern (a `beforeToolCall` guard scoped by capability). Matches CLAUDE.md's "new behavior is always an extension".
- **Why (a) rejected:** duplicates the check in ≥4 sites, misses future `self:extend` tools, and edits two load-bearing extensions unnecessarily.

### Decision 2 — Capability-scoped targeting vs. a hardcoded tool-name list
- **Problem:** which calls does the guard act on?
- **Options:** (a) a hardcoded set `{propose_improvement, adopt_improvement, write_extension, reload_extension}`; (b) any call whose tool declares `self:extend`, via `e.agent.tools.get(call.name)?.capabilities`.
- **Choice: (b).** `risk-guard.ts:104` establishes exactly this lookup (`capsOf = (name) => e.agent.tools.get(name)?.capabilities ?? []`). Capability is the security vocabulary (CLAUDE.md); gating by it is robust to renames and new tools.
- **Why (a) rejected:** brittle, drifts as tools are added/renamed; duplicates knowledge the registry already holds.

### Decision 3 — Floor policy: allowlist of model substrings, inert-by-default
- **Problem:** how is "capable enough" expressed, and what is the default?
- **Options:** (a) allowlist of model-substring patterns, empty ⇒ inert (opt-in); (b) a baked-in list of known-capable models; (c) a denylist of weak models.
- **Choice: (a).** The allowlist is `config.get("selfExtendFloor.models", "")`, comma-separated, case-insensitive substring match against `e.agent.model`. Empty/unset ⇒ the guard never blocks (backward-compatible, opt-in — consistent with EAgent's "opt-in ships off"). When configured, a model matching **no** pattern is blocked, so an unknown/new model that matches nothing is refused rather than trusted.
- **Substring matching cuts both ways — the over-allow hazard is the dangerous one.** Substring (not exact) match is deliberate so a single pattern like `opus` matches `claude-opus-4-8`. But it means a *weaker* variant whose id **contains** an allowlisted substring is admitted: `gpt-4` matches `gpt-4o-mini`; `opus` would match any future `*opus*` id regardless of tier. That is precisely the STOP failure mode (a weak model driving self-extension) the floor exists to prevent, so the "unknown model refused" safety property holds only for ids that match *nothing*, not for weaker substring-collisions. **Operator guidance (documented in the README row and CHANGELOG):** write the most specific patterns that still match your intended ids (e.g. `opus-4`, `sonnet-4`, `gpt-5` rather than bare `gpt`), since matching is by contains. Anchoring the match was considered and rejected: it would defeat the intended `opus`→`claude-opus-4-8` ergonomics and push operators toward brittle full-id lists (a stale-defaults pressure). The over-allow residue is accepted, operator-mitigable, and called out in §8's over-allowing risk.
- **Why (b) rejected:** a baked model list is the stale-defaults anti-pattern (§3); it would also silently start blocking existing users on models not in the list. **Why (c) rejected:** a denylist fails *open* — a newly-released weak model not on the list slips through, the opposite of a safety floor.

### Decision 4 — Acting-model source: `e.agent.model`
- **Problem:** how does the guard know the acting model? `beforeToolCall`'s context is only `{ call }` (no model — `events.ts:101-104`).
- **Options:** (a) `e.agent.model` (root agent); (b) capture the model from `transformRequest`/`transformContext` events into a closure variable; (c) resolve the *acting* agent via the `currentActingAgent()` seam (`agent.ts:76`, described in CLAUDE.md as "so soft-guards act on the acting sub-agent").
- **Choice: (a),** exactly as `risk-guard.ts:166` does. **Why (b) rejected:** strictly more machinery for the same value the agent already exposes. **Why (c) deferred, not chosen:** a competence floor arguably *wants* the acting sub-agent's model (a capable root could spawn a weak `self:extend` sub-agent — see §8's sub-agent under-blocking risk), which makes this a real limitation, not merely a mirror of risk-guard's defense-in-depth role. It is deferred for Wave 2 because (i) `self:extend` sub-agents are themselves an unusual, capability-gated path, (ii) wiring `currentActingAgent()` correctly into a `beforeToolCall` guard is its own design surface worth a dedicated follow-up, and (iii) the root-model floor already closes the common single-agent case the STOP lesson targets. The residual gap is recorded in §3 and §8's sub-agent under-blocking risk, not silently accepted.

### Decision 5 — Ordering and non-interference
- **Problem:** must the guard run in a particular position, and does it disturb other guards?
- **Evidence (verbatim):** `beforeToolCall` is applied with `shouldStop = (d) => d.block` (`agent.ts:496-501`), and a block returns before the capability check (`agent.ts:502-504`). So (i) any guard's block short-circuits the chain, and (ii) a floor block refuses the call *before* the `self:extend` capability prompt.
- **Choice:** register the guard via `e.hook("beforeToolCall", …)`; on entry, if the call's tool lacks `self:extend`, or the guard is killed, or the allowlist is empty, return `decision` unchanged. Placement in `BUILTIN_EXTENSIONS`: after `self-improve`. Because a prior guard's block already short-circuits (the floor never runs after an upstream block) and the capability lookup is live at call time, registration order does not affect correctness.

### Decision 6 — The guard declares no capability
- **Problem:** does the guard itself need a capability?
- **Choice:** no. Like `risk-guard`, the `beforeToolCall` hook exercises no privileged authority (it only reads the registry + model and returns a decision). It registers a hook, not a tool.

## 5. Dependencies and Assumptions

- **ExtensionAPI surface used:** `e.hook("beforeToolCall", …)`, `e.agent.tools.get(name)?.capabilities` (registry lookup — `risk-guard.ts:104`), `e.agent.model` (acting model — `risk-guard.ts:166`), `e.config` (`get`/`string`/`enabled` — `store.ts:26-35`), `e.log.warn` (the block observability line). No `e.registerTool`, no `e.registerCommand`.
- **Config / kill-switch mapping (pinned):** the guard is gated by `e.config.enabled("self-extend-floor", { default: true })` → env veto `EAGENT_SELF_EXTEND_FLOOR=off` fully disables it; the allowlist is `e.config.get("selfExtendFloor.models", "")` → env `EAGENT_SELF_EXTEND_FLOOR_MODELS` (comma-separated). All reads go through `e.config`, never `process.env` directly (house convention). "Inert by default" is the empty-allowlist state (`enabled` defaults true so the hook runs, but with no patterns it never blocks).
- **`ToolDecision` shape** `{ block, reason?, arguments }` and the `beforeToolCall` filter signature `(decision, { call }) => decision` (`events.ts:53-59, 101-104`).
- **`beforeToolCall` semantics:** `shouldStop = d => d.block`, block precedes capability check (`agent.ts:496-504`).
- **Assumption:** `e.agent.model` is a non-empty model-id string at call time (holds in every host; `risk-guard` already depends on it).
- **Depends on** the centralized `e.config` facility (`docs/design/2026-07-07-centralized-config.md`) for the allowlist key and env kill — a consumer, not a modifier.

## 6. Relationship with Existing Designs

- Prior designs: `docs/design/2026-07-07-centralized-config.md` (consumed for config) and `docs/design/2026-07-09-playbook-extension.md` (Wave 1 — sibling, no interaction). No conflict; this is a new, additive guard extension.
- Terminology anchors: CLAUDE.md (capabilities as the security vocabulary; `self:extend`), and the docstrings of `risk-guard.ts` (the guard precedent), `self.ts`, and `self-improve.ts`.
- No warning markers required: additive extension touching only `host.ts` (append), `README.md`/`CHANGELOG.md` (append), and a new test file.

## 7. Acceptance Criteria (measurable, automatable — offline `node:test`)

Test harness: `makeHarness()` gives an `agent` with `model: "mock"`. Load the extension through the real host (`await host.use("self-extend-floor", activate)`), register a probe tool declaring `capabilities: ["self:extend"]` and a control tool with none (via `agent.tools.register`), set config on `h.config`, then drive the guard through the real hook chain via `agent.hooks.apply("beforeToolCall", { block:false, arguments:{} }, { call })`. Loading via `host.use` (not calling `activate` bare) means the ACs also exercise real registration.

1. **Inert by default:** with no allowlist configured, a `self:extend` probe call returns `block === false` (guard performs no gating).
2. **Allowed model passes:** allowlist `"mock"` (matches `e.agent.model === "mock"`) → `self:extend` probe call returns `block === false`.
3. **Below-floor model blocked:** allowlist `"opus,sonnet"` (no substring of `"mock"`) → `self:extend` probe call returns `block === true` with a `reason` that names the floor and the acting model.
4. **Capability-scoped:** with the same blocking allowlist, a call to the **control** tool (no `self:extend`) returns `block === false` — only `self:extend` tools are gated.
5. **Kill switch:** with `EAGENT_SELF_EXTEND_FLOOR=off` set and a blocking allowlist + below-floor model, the `self:extend` probe call returns `block === false` (guard fully inactive).
6. **Case-insensitive substring match:** allowlist `"MOCK"` with model `"mock"` → passes (`block === false`); confirms case-insensitivity.
7. **Unknown tool tolerated:** a `beforeToolCall` for a `call.name` not in the registry (no spec) returns `block === false` (no throw) — `capsOf` returns `[]`.
8. **Registration + observability:** loading the extension via `host.use` increases `agent.hooks.listenerCount("beforeToolCall")` by one (proves `activate` wires the hook through real registration); and a block (AC 3) emits an `e.log.warn` line containing the tool name and the acting model (assert via a capturing logger).
9. **Suite gates green:** `npm run typecheck` exits 0; `npm test` exits 0 (includes `test/kernel-surface.test.ts`, proving no kernel-line growth). Test-file types verified separately (the `test/` tree is untypechecked by both gates). BUILTIN_EXTENSIONS membership (that the assembled host loads the guard) is confirmed by a main-agent PhaseEnd smoke, mirroring Wave 1.

Quality budget: the guard runs on every tool call; its cost is one map lookup + (only for `self:extend` tools) a substring scan — no network/model call. No latency budget beyond "no I/O" applies (Scope Boundary).

## 8. Risks and Rollback

- **Risk: over-blocking (a capable model refused because its id lacks the configured substring).** Mitigated by opt-in (inert until configured) + substring (not exact) matching + the operator choosing patterns; documented that patterns are substrings of the model id.
- **Risk: over-allowing (a weaker variant admitted because its id CONTAINS an allowlisted substring — e.g. `gpt-4` matching `gpt-4o-mini`).** This is the safety-relevant direction (a weak model slipping past the floor). Mitigated by operator guidance to use the most specific patterns that still match (Decision 3), and by the block-time `e.log.warn` making a firing/non-firing floor observable. Accepted as a residual limitation of substring matching, not silently ignored; a tighter matching mode is a possible follow-up.
- **Risk: under-blocking via sub-agent model override** (a sub-agent on a weak model while `e.agent.model` is capable). Acknowledged and out of scope (§3); mirrors `risk-guard`'s existing `e.agent.model` behavior. Recorded as a known limitation, not silently ignored.
- **Risk: interfering with other `beforeToolCall` guards.** Mitigated: the guard returns `decision` unchanged on all non-gated paths and only ever sets `block: true` (never clears an upstream block, which it never sees due to `shouldStop`).
- **Risk: kernel-ceiling regression.** Mitigated: no `src/kernel/*` edits; AC 9 runs `test/kernel-surface.test.ts`.
- **Rollback:** runtime — `EAGENT_SELF_EXTEND_FLOOR=off` or clear `selfExtendFloor.models` (instant inert). Permanent — remove the `BUILTIN_EXTENSIONS` line + delete the extension/test + README/CHANGELOG rows; no persisted state to migrate.
