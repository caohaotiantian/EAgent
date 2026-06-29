# Design — `transformRequest` keystone seam

```
Status: closed
Closing-commit: 53ad0b2
Closed-on: 2026-06-28
Deferred: none
```

**Slug:** `2026-06-28-transform-request` · **Wave:** 2 · **Mode:** Full
**Source:** [`docs/ROADMAP.md`](../ROADMAP.md) · **Strategy:** [`2026-06-28-eagent-redesign-blueprint.md`](2026-06-28-eagent-redesign-blueprint.md) §3 P1.1

## 1. Background and Purpose

The request-shaping seam is the highest-leverage of the four irreducible seams and is currently
amputated: `transformContext` (`events.ts:52-55`) lets extensions rewrite only the **message array**,
while `streamTurn` always ships `this.tools.list()` (`agent.ts:284`) and a system prompt / model /
thinking / toolChoice that **no hook can touch**. As a result, per-turn tool exposure (least-privilege
to the model), dynamic system-prompt assembly, model routing, prompt-cache boundary control, plan/act
mode tool allowlists, progressive disclosure, and budget-aware shaping all have to ride **mutable
`Agent` fields** (`Agent.model`, `Agent.systemPrompt`, `Agent.forceTool`) instead of a composable hook
— they cannot stack, and no extension can withhold a tool from the model.

This wave adds **one filter, `transformRequest`**, that hands extensions the assembled outbound request
(system prompt, messages, tools, model, toolChoice, thinking) plus cumulative usage, right before the
provider call. It deepens the most valuable seam so a whole class of extensions (memory injection,
per-turn tool masking, routing, plan/act modes, progressive disclosure, cache control) becomes
expressible on one composable point — the textbook small-kernel move (power, not features).

If we skip it: every later capability wave (memory in Wave 7, search in Wave 8, routing upgrades)
keeps hacking mutable `Agent` fields, which don't compose and can't filter the tools list at all.

## 2. Deliverables

- [ ] **D1** Add a `transformRequest` filter point to `KernelFilters` (`src/kernel/events.ts`): value =
  `{ systemPrompt: string; messages: Message[]; tools: ToolSpec[]; model: string; toolChoice?: ToolChoice;
  thinking?: ThinkingLevel }`, context = `{ turn: number; cumulativeUsage: Usage }`.
- [ ] **D2** `src/kernel/agent.ts` `streamTurn`: after building `req`, apply `transformRequest` to the
  shapeable fields (carrying `signal` through unchanged), and stream the shaped request. When no handler
  is registered the streamed request is byte-identical to today.
- [ ] **D3** `transformContext` is retained and applied **first** (to the messages), with its output
  flowing into `transformRequest`'s `messages`. No existing extension changes.
- [ ] **D4** Tests: each shapeable field is mutable via the hook and reaches the provider; default
  (no handler) byte-identity; ordering (`transformContext` before `transformRequest`); `cumulativeUsage`
  is populated; `kernel-surface.test.ts` green (`< 2200` lines; export list unchanged or intentionally
  updated).

## 3. Scope Boundary (NOT in scope)

- **No migration** of `routing`/`templates`/`output-contract` off their current mutable-`Agent`-field
  approach onto `transformRequest`. They keep working unchanged; opt-in migration is a later follow-up.
- **No** removal or deprecation of `transformContext` (11 extensions register it — see KDD-2).
- **No** dispatch-time enforcement of the request `tools` list: filtering tools in the request withholds
  them from the **model**, but execution still resolves by name via the live `this.tools` registry
  (`this.tools.get(call.name)`, `agent.ts:363`). Enforcing "only request-listed tools may execute" is a
  separate concern (a `beforeToolCall` guard can already veto). See KDD-4.
- **No** new filter-throw containment: a throwing `transformRequest` is fatal to the turn, exactly like
  `transformContext` and the documented filter contract (`hooks.ts:90-92`). See KDD-5.
- **No** new sampling/cache fields on `CompletionRequest` (temperature, cache breakpoints) — that is a
  later wave; this wave exposes only the fields the request already carries.

## 4. Key Design Decisions

### KDD-1 — Filter value shape
*Problem:* which request fields should the hook expose and allow mutating? *Options:* (a) the whole
`CompletionRequest` including `signal`; (b) a curated subset of the shapeable fields, excluding
`signal`. *Choice:* **(b)** — `{ systemPrompt, messages, tools, model, toolChoice, thinking }`. `signal`
is abort control, not a shaping concern, and a handler returning a broken/mutated signal could wedge
abort; the kernel re-attaches the live `signal` after the hook. *Rejected:* (a) leaks a control field
and couples the hook to `AbortController` internals.

### KDD-2 — Relationship to `transformContext`
*Problem:* `transformContext` already reshapes messages; do we keep it or fold it in? *Options:*
(a) keep `transformContext`, apply it first (to messages), feed its output into `transformRequest`;
(b) deprecate `transformContext` and reimplement it atop `transformRequest`. *Choice:* **(a)** — 11
extensions register `transformContext` (`compact`, `config-hooks`, `context-files`, `drift-probe`,
`goal`, `handoff`, `microagents`, `prune`, `skills`, `skills-hardening`, `templates`); folding would be
a breaking change to a load-bearing surface for zero functional
gain this wave. Keeping both, ordered (context → request), is back-compatible and still lets new code
use the deeper hook. *Rejected:* (b) is a gratuitous breaking change (violates Surgical Changes).

### KDD-3 — Context payload
*Problem:* what context does a `transformRequest` handler need? *Options:* (a) `{ turn }`;
(b) `{ turn, model }`; (c) `{ turn, cumulativeUsage }`. *Choice:* **(c)** — `model` is now a **mutable
field of the value** itself (a router rewrites `value.model`), so it does not belong in the read-only
context; `cumulativeUsage` is what budget-aware shaping (truncate/route when spend crosses a threshold)
needs. *Rejected:* (a) too thin for budget shaping; (b) duplicates `model` redundantly and immutably.

### KDD-4 — Tools-list semantics (advisory to the model, not a dispatch gate)
*Problem:* if a handler removes a tool from `value.tools`, can the model still execute it? *Options:*
(a) the request `tools` list is **advisory** — it controls what the model *sees*; dispatch still
resolves any returned call by name via `this.tools` (unchanged); (b) also gate dispatch so only
request-listed tools may execute. *Choice:* **(a)** — Surgical: dispatch name-resolution
(`this.tools.get(call.name)`, `agent.ts:363`) is untouched,
and withholding a tool from the model is the actual use case (progressive disclosure / least-privilege
to the model). A hard execution gate is a distinct policy expressible today via `beforeToolCall`.
*Rejected:* (b) couples request-shaping to dispatch enforcement and changes dispatch semantics in a
seam-adding wave. Documented so an author isn't surprised.

### KDD-5 — Throw semantics (no new containment)
*Problem:* should a throwing `transformRequest` handler be contained? *Options:* (a) fatal to the turn,
consistent with `transformContext` and the filter contract (`hooks.ts:90-92` — "filter errors are fatal
to the chain by design"); (b) wrap in try/catch and continue with the pre-hook request. *Choice:*
**(a)** — consistency with the existing, deliberate filter-throw contract; a request-shaping filter that
throws is a programming error that should surface, not be silently swallowed (which could send an
unintended request). *Rejected:* (b) contradicts the documented contract and would mask bugs.

### KDD-6 — `toolChoice` from a handler is trusted
*Problem:* `Agent.forceTool` is guarded against naming an unregistered tool (`this.forceTool &&
this.tools.get(this.forceTool)`, `agent.ts:293-296`); should
a `transformRequest`-set `toolChoice` be guarded too? *Options:* (a) trust the handler (no extra guard);
(b) re-validate the handler's `toolChoice` against the registry. *Choice:* **(a)** — `transformRequest`
is a power seam; the kernel trusts filter output (as it trusts `beforeToolCall`'s rewritten args after
re-validation, and `transformContext`'s messages). The `forceTool` guard remains for the `forceTool`
path. *Rejected:* (b) adds kernel policy to a deliberately unopinionated seam; an extension that sets a
bad `toolChoice` gets a provider error, which is the right feedback. Noted in Risks.

## 5. Dependencies and Assumptions

No upstream wave dependency. Builds on the existing `HookBus.apply` (`hooks.ts:93-107`) — `transformRequest`
uses the same threading as `transformContext` (no `shouldStop`). Assumes `ToolSpec`, `ToolChoice`,
`ThinkingLevel`, `Usage` are importable into `events.ts` from `types.ts` (they are). Assumes the
`MockProvider` records the request it received (or a test provider captures it) for assertions.

## 6. Relationship with Existing Designs

Strategy parent: blueprint §3 P1.1. **Coincident with** Wave 1 (`2026-06-28-phase0-foundation.md`) but
no functional dependency on it — `context.cumulativeUsage` is just the running total (`this.#usage`,
accumulated at `agent.ts:314`) and works with the original 2-field `Usage` as well as Wave 1's widened one. Related
prior design `2026-06-20-reasoning-thinking-support.md` introduced `thinking`/`ThinkingLevel` on the
request; `transformRequest` now exposes that field to extensions (extends, no conflict). Terminology
anchor: the CLAUDE.md prose at **CLAUDE.md:40-42** enumerates "three filter hooks
`transformContext`/`beforeToolCall`/`afterToolCall`"; this adds a **fourth** point, so that passage
becomes stale and is reconciled at F (step 8). ⚠ load-bearing-doc surface (CLAUDE.md).

## 7. Acceptance Criteria (measurable, automatable)

- **AC-1** `npm run typecheck` exits 0.
- **AC-2** `npm test` exits 0 (existing + new).
- **AC-3** New `agent.test.ts` case: a `transformRequest` handler that sets `value.model = "X"`,
  drops a tool from `value.tools`, appends to `value.systemPrompt`, sets `value.toolChoice` and
  `value.thinking`, and edits `value.messages` results in the provider receiving a request with all of
  those changes (capture the `CompletionRequest` via `MockProvider`'s **function responder** —
  `new MockProvider((req, turnIndex) => …)`, whose closure receives the full request — or a small
  capturing test provider; `MockProvider` has no `lastRequest` field).
- **AC-4** New `agent.test.ts` case (default byte-identity): with **no** `transformRequest` handler, the
  request the provider receives (captured via the function responder) has the same
  `systemPrompt`/`tools`/`model`/`toolChoice`/`thinking` and `messages` as before this change.
- **AC-5** New `agent.test.ts` case (ordering): with both a `transformContext` (mutates messages) and a
  `transformRequest` handler registered, the `transformRequest` handler observes the
  `transformContext`-mutated messages in `value.messages` (context runs first).
- **AC-6** New `agent.test.ts` case: after a prior turn consumed tokens, a `transformRequest` handler on
  the next turn sees a non-zero `context.cumulativeUsage` matching the agent's accumulated usage.
- **AC-7** `kernel-surface.test.ts` passes: `src/kernel/` `< 2,200` lines; the pinned public export list
  is unchanged (a `KernelFilters` map key is a type addition, not a new runtime export) or the pin is
  intentionally updated with justification.

*Quality budget:* the hook adds one `hooks.apply` call per turn over a small object — negligible, not a
hot path beyond the existing per-turn provider call; excluded from a numeric budget.

## 8. Risks and Rollback

- **R1 — A `transformRequest` handler sets an invalid `model`/`toolChoice`, causing a provider error.**
  *Mitigation:* KDD-6 — this is the handler's responsibility; the provider error surfaces normally. The
  kernel default (no handler) is byte-identical (AC-4), so the risk exists only for code that opts in.
  *Rollback:* remove the `transformRequest` apply call; the filter point becomes inert.
- **R2 — Default behavior drift** (the new apply path changes the request even with no handler).
  *Mitigation:* AC-4 asserts byte-identity; `hooks.apply` returns the value unchanged when no handler is
  registered (`hooks.ts:99-100`). *Rollback:* revert `streamTurn` to build-and-stream directly.
- **R3 — A handler mutates `value.tools`/`messages` in place vs returns a new value.** *Mitigation:*
  the kernel reads the **returned** value (filter contract); document that handlers must return the
  (possibly mutated) value. AC-3 exercises a returning handler. *Rollback:* n/a (contract, not code).
- **R4 — CLAUDE.md "three filter hooks" becomes stale.** *Mitigation:* reconcile at F step 8 (this is a
  load-bearing-doc surface). *Rollback:* n/a.

The whole change is one filter point + one `apply` call; reverting the `apply` call fully restores
prior behavior.

## L1 Review Log

- **Round 1** — zero severe + general (factual-precision: "52→~13" extension count, drifted agent.ts
  line citations, non-existent `MockProvider.lastRequest`, §5/§6 dependency framing). Fixed.
- **Round 2** — zero severe + 1 general (count fix incomplete: §3 still "52"; `memory`/`routing`
  wrongly listed). Corrected to **11** with exact members.
- **Round 3** — **zero severe, zero general** (one cosmetic wrap note). 
- **Round 4 (corroborating)** — **zero severe, zero general.** Cap-convergence policy
  ([[three-loop-cap-convergence-policy]]) — two-generation satisfied. **L1 closed.**
