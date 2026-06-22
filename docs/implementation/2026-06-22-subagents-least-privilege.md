# Implementation: `subagents-least-privilege` — per-spawn capability allowlist, provider override, typed return

Guides a fresh agent through TDD delivery of the three optional, default-off
passthroughs designed in
[`docs/design/2026-06-22-subagents-least-privilege.md`](../design/2026-06-22-subagents-least-privilege.md)
(**PASSED** — read it first; it is the single source of truth for the *behavioral*
contract, and this log adds **no requirement absent from it**). This log deviates
from the design on exactly one *non-behavioral* point — the extension's file
**shape** (§0 below) — and justifies that deviation only from material visible in
the design itself; it appeals to no authority a fresh reader cannot inspect.

## 0. Build-shape note (read before touching code)

The design's §2/§4-D7 describe a *new shadow file* (`subagents-least-privilege.ts`)
that re-registers `spawn_agent`/`run_workflow`. **This build does NOT take that
shape:** the three behaviors are added **in place** to the two existing
extensions. This is a deliberate, narrow departure from D7's chosen shape, and it
is justified entirely from the design's own visible text — not from any external
authority.

**Why this departure, grounded only in the design itself.** D7 frames the choice
as shadow (option 1) *vs.* edit-in-place (option 2), and its own cost ledger
(D7 "Cost of this choice, stated plainly"; §2 "Real cost") is explicit that
option 1 forces re-implementing `dynamic-workflow`'s **entire DAG scheduler plus
its guard-sequence mirror (~200 LoC)**, because the helpers that must be
generalized (`makeChild`/`runChild`/`childRegistryFrom`/`readOnlyCapabilities`
in `subagents.ts`; `runAgentStep`/`workflowChildRegistry`/`STEP_SCHEMA` in
`dynamic-workflow.ts`) are module-private and the design forbids widening their
exports. D7's stated reason for *rejecting* option 2 (lines 346–348) is that
in-place editing was "out of scope for this batch (only `src/extensions/<name>.ts`,
`test/<name>.ts`, `docs/` may change)" and would make the feature
"non-disposable as a unit." This build judges those two grounds not to hold for
*this* batch: (a) the footprint actually changed here is observable and minimal —
the two **already-builtin** extensions, their two existing test files, and this
doc, with **no** new scheduler written and the design's own ~200 LoC duplication
*avoided* (so the footprint is strictly smaller than option 1's, not larger);
and (b) disposability is preserved by the kill switch and by the host's
synthesized teardown of each extension's tracked registrations (these two
`activate`s return `void`; `extension.ts:88-89`,`:255` — see the AC-10 note
below), so no separate-file packaging is needed to keep teardown clean. In short: option 2 is taken because, weighed on D7's
*own* ledger, it pays the lower price the design already priced — re-using the
private helpers in place instead of copying the scheduler — while preserving
every property D7 cited in option 1's favor.

Every *behavioral* requirement (D1–D6, AC-1…AC-9, AC-11) is preserved verbatim;
only D7's "shadow vs. edit-in-place" *shape* sub-choice (and AC-10's
shadow-restore phrasing, which is downstream of it — see the callout below) is
resolved toward edit-in-place for this batch. No behavior is added, narrowed, or
removed; the design remains the single source of truth for *what* the feature
does.

Concretely:

- **MODIFY** `src/extensions/subagents.ts` — add three optional `spawn_agent`
  params (`capabilities`, `provider`/`model`, `outputSchema`/`require`) and plumb
  them through `makeChild`/`runChild`.
- **MODIFY** `src/extensions/dynamic-workflow.ts` — add the same fields to
  `STEP_SCHEMA` and route the `agent` step (`runAgentStep`) through the same
  generalized child-builder logic (D6 parity).
- **EXTEND** `test/subagents.test.ts` and `test/dynamic-workflow.test.ts` with the
  new offline cases. Existing tests in both files MUST stay green (D4/AC-7
  regression).

**BATCH MODE — do NOT touch:** `src/host.ts`, `CLAUDE.md`, `README.md`. The design
already marks "host.ts registration" and "CLAUDE.md/README inventory" as
*(deferred to batch integration)* (design §2 Deliverables, last two boxes); do
**not** bump the README extension count. `subagents` and `dynamic-workflow` are
already in `BUILTIN_EXTENSIONS`, so no registration work is needed — the new tests
load nothing new; they exercise the modified extensions via the existing
`host.use("subagents", subagents)` / `host.use("dynamic-workflow", dynamicWorkflow)`
calls already present in those test files.

**Kill switch.** `EAGENT_SUBAGENTS_LP=off` must make the three new params a no-op
(child behaves as today). Because the behavior now lives inside the existing
`activate` functions, implement the kill switch as a single boolean read at the
top of each `activate` (e.g. `const lp = process.env.EAGENT_SUBAGENTS_LP !== "off"`)
that gates *only the new param handling* — the original spawn/workflow behavior is
unaffected either way. (Design §2 Deliverable "Kill switch"; §8 "Kill switch".)

---

## 1. Task Index — design Deliverables + Acceptance Criteria → phase tasks

There is **one phase**: the three features are independent code paths sharing a
single generalized child-builder (design §8 "The three are unrelated code paths
sharing only the child-builder"), so they are not separable into ordered phases —
they share the same files, the same builder, and the same regression surface.

| Design item | What it requires | Phase 1 task(s) |
| --- | --- | --- |
| Deliverable: capability allowlist (D1, §1-A) | `capabilities: [...]` → fresh deny-fallback `CapabilityManager`; `readOnly` = sugar for `["fs:read","skill:read"]` | T2 (test), T3 (impl) |
| Deliverable: provider/model override (D2, §1-B) | validate `provider` vs `e.agent.providers.get`; fall back + warn on miss; `model` override | T4 (test), T5 (impl) |
| Deliverable: typed return (D3, §1-C) | append contract instruction; validate final JSON via `validate.ts`; one re-prompt then `contract violation:` fail | T6 (test), T7 (impl) |
| Deliverable: backward-compat (D4) | none-supplied ⇒ byte-identical to today | T0 (regression baseline), T1 (test), enforced by every impl task |
| Deliverable: workflow parity (D6) | same four fields on `agent` step; same builder | T8 (test), T9 (impl) |
| Deliverable: kill switch `EAGENT_SUBAGENTS_LP=off` (§2, §8) | new params no-op when off | T10 (test), T11 (impl) |
| Deliverable: `/agents` help documents new params (§2) | help text mentions the three params | T12 (impl; folded into existing `/agents` command) |
| Deliverable: this implementation log (§2) | written at build time | this file |
| Deliverable: host.ts registration | **deferred to batch integration** — DO NOT do here | — |
| Deliverable: CLAUDE.md/README inventory + count | **deferred to batch integration** — DO NOT do here, DO NOT bump count | — |
| AC-1 allowlist denies-outside/allows-inside | `capabilities:["shell:exec"]` runs `lint`, denies `mutate`; parent `fallback:"allow"` | T2 → T3 |
| AC-2 `readOnly` is sugar for preset | `readOnly:true` ⇒ reads resolve, write/exec/fetch reject | T2 → T3 |
| AC-3 provider override hits named provider | register second provider `critic`; `provider:"critic"` reaches it, parent not | T4 → T5 |
| AC-4 override falls back on unregistered name | `provider:"nope"` ⇒ parent provider used, no throw, `warn` emitted | T4 → T5 |
| AC-5 typed return validates | valid JSON ⇒ not error; parsed object in result `details` | T6 → T7 |
| AC-6 one re-prompt then fail / invalid→valid rescues | invalid×2 ⇒ run twice, `isError`, `/contract violation/`; invalid→valid ⇒ not error | T6 → T7 |
| AC-7 regression: none-supplied == today | parent manager shared, parent provider/model, free-text `finalText`, no contract | T0, T1 |
| AC-8 workflow parity | `agent` step with `capabilities`/`provider`/`outputSchema` shows AC-1/AC-3/AC-5 inside the DAG | T8 → T9 |
| AC-9 kill switch | `EAGENT_SUBAGENTS_LP=off` ⇒ AC-1 scoping does **not** occur | T10 → T11 |
| AC-10 clean teardown | edit-in-place equivalent: `host.unload("subagents")` throws nothing and removes `spawn_agent` (post-unload spawn inert); see §0 AC-10 callout | T11 (positive unload assertion) + T13 |
| AC-11 offline + typecheck | `npm test` + `npm run typecheck` green, no network/key | T13 (exit gate) |

> AC-10 in the design asserts `host.unload` restores the original
> `spawn_agent`/`run_workflow` via registry shadow-restore — that wording is a
> mechanical consequence of D7's *shadow-file* shape, so resolving D7 toward
> edit-in-place (§0) necessarily reinterprets it; this is not a second,
> independent override but the same one, read through to its AC. In the
> edit-in-place shape there is no second registration to restore: the original
> tools are simply the modified tools. Note these two `activate`s today return
> `void` (`subagents.ts:43`, `dynamic-workflow.ts:104`); teardown is synthesized
> by the host from the registrations each tracks (`extension.ts:88-89`,`:255`),
> so the house rule here is **do not introduce a throwing teardown** (do not add a
> `return () => {…}` that can throw) — there is no pre-existing dispose loop to
> "keep intact."
>
> The *invariant* AC-10 protects — "deactivation is clean and throws nothing,
> and a post-unload spawn no longer carries the new behavior" — is **not** left to
> ride solely on other suites staying green. Resolving AC-10 toward edit-in-place
> changes its *mechanism* (no shadow to restore) but **keeps its testable
> obligation**, so this build adds a positive edit-in-place-equivalent assertion
> in place of the design's shadow-restore one: load the modified extension,
> `await host.unload("subagents")`, and assert (a) the unload throws nothing and
> (b) `agent.tools.get("spawn_agent")` is gone (the host removed the registration),
> i.e. a post-unload spawn is unavailable/inert. (See T11 and the T13 exit gate.)
> Do **not** add a *shadow-restore* assertion (there is no shadow to restore); do
> add the unload-is-clean assertion just described.

---

## 2. Phase Breakdown — Phase 1 (single phase): the three passthroughs + workflow parity

### Entry condition

- Repo at `/private/tmp/eagent-wt/subagents-lp`, on the working branch.
- Baseline green: `npm test` and `npm run typecheck` both pass *before* any edit
  (capture this; it is the regression floor — see §5).
- You have read the design doc end-to-end and §0 of this log.

### Design refs

- Behavior contract: design §1 (A/B/C), §4 (D1–D6), §7 (AC-1…AC-11).
- Reuse map: `CapabilityManager({ grant, fallback:"deny", ui })`
  (`src/kernel/capabilities.ts:65`); `ProviderRegistry.get` returns `undefined`
  for unknown names (`src/kernel/registry.ts:73-75`); `validate(schema, input)`
  → `{ ok, value, errors }` with coercion (`src/kernel/validate.ts:19`);
  recovery-style single nudge precedent (`src/extensions/recovery.ts`).
- Surfaces to modify: `subagents.ts:59-82` (`makeChild`/`runChild`),
  `:98-133` (`spawn_agent` `parameters`), `:194-204` (`READ_ONLY_GRANTS` /
  `readOnlyCapabilities`); `dynamic-workflow.ts:63-87` (`STEP_SCHEMA`),
  `:435-454` (`runAgentStep`).
- `e.agent.providers` / `e.agent.providerName` / `e.agent.model` /
  `e.agent.capabilities` / `e.agent.ui` are the parent values to inherit when a
  param is omitted (today's exact values — `subagents.ts:60-69`); `e.log.warn` is
  the warn channel (`ExtensionAPI.log`, `extension.ts:59`,`:235`).

### Task list (strict TDD order — each TEST names the business invariant it protects and precedes the impl it protects)

> **TDD discipline.** Write the test first, run it, watch it **fail for the right
> reason** (the new behavior is absent), then write the minimal impl that makes it
> pass without breaking any prior test. Commit per the convention in §3.

---

#### T0 — Regression baseline (no code change)

**Invariant protected (D4/AC-7): a spawn supplying none of the three params is
byte-identical to today.** Establish the floor before changing anything.

- Run the two target suites and the full suite; record that they pass. The
  existing tests `"a default (non-readOnly) child shares the parent's
  capabilities and may mutate"` (`subagents.test.ts:282`) and
  `"AC-3: an agent step's child output is captured and substitutable"`
  (`dynamic-workflow.test.ts:345`) already encode "none-supplied == today" and
  MUST stay green through every later task.

Acceptance (from repo root):
```
node --import tsx --test test/subagents.test.ts test/dynamic-workflow.test.ts
npm run typecheck
npm test
```
All exit 0.

---

#### T1 — TEST: none-supplied path unchanged (explicit AC-7 lock)

**Invariant protected (D4/AC-7): omitting `capabilities`/`readOnly`/`provider`/
`model`/`outputSchema` reproduces the full-inherit manager, parent provider/model,
and free-text `finalText` return — no JSON contract applied.**

- In `test/subagents.test.ts`, add a test that spawns `mode:"single"` with *none*
  of the new params and asserts: a parent-allowed `fs:write` tool runs (child
  shares the parent manager — mirror `subagents.test.ts:282-293`), and the tool
  result is the child's free-text answer (not JSON, no `contract violation`).
  This pins the regression contract even after T3/T5/T7 add branches.

Acceptance:
```
node --import tsx --test test/subagents.test.ts
```
Passes (this test plus all pre-existing ones).

---

#### T2 — TEST: capability allowlist denies outside / allows inside; `readOnly` is sugar

**Invariant protected (D1/AC-1, AC-2): a child is scoped to an arbitrary
capability *subset* via a fresh deny-fallback manager; granted patterns run,
everything else is refused at the capability boundary; `readOnly:true` is exactly
the preset `["fs:read","skill:read"]`.**

- **AC-1:** Register a `mutate` tool declaring `fs:write` (reuse the
  `mutateTool` helper at `subagents.test.ts:228`) and a `lint` tool declaring
  `shell:exec`. Build the harness with `fallback:"allow"` on the parent (so any
  denial is unambiguously the *child* manager's, not the parent's — design AC-1).
  Spawn a child with `capabilities:["shell:exec"]`; script the child to call
  `lint` then `mutate`. Assert: the `lint` flag flips (allowed) and the `mutate`
  flag stays false (`CapabilityError`, denied).
- **AC-2:** Spawn with `readOnly:true`; assert `fs:read` resolves and
  `fs:write`/`shell:exec`/`net:fetch` reject — identical to
  `readOnlyCapabilities` (`subagents.test.ts:216-225`). Also assert that supplying
  both `capabilities` and `readOnly` lets `capabilities` win (design §4-D1
  "Precedence").

Acceptance (test present, currently **failing** — feature absent):
```
node --import tsx --test test/subagents.test.ts
```

---

#### T3 — IMPL: generalize the read-only path to an arbitrary capability subset

**Makes T1/T2 pass.** (Design D1.)

- Generalize `readOnlyCapabilities` (or add a sibling) into a builder that takes a
  `grant: string[]` and returns
  `new CapabilityManager({ grant, fallback:"deny", ui })` — `READ_ONLY_GRANTS`
  becomes the *preset array* passed for `readOnly:true`. Keep
  `readOnlyCapabilities` exported and behavior-identical so the existing
  `subagents.test.ts:216` test stays green.
- Add `capabilities` (array of strings) and keep `readOnly` (boolean) on the
  `spawn_agent` `parameters` (`subagents.ts:98-133`). Coerce defensively (only
  string entries; mirror the project's `asPrompts`/typeof-guard posture).
- In `makeChild` (`subagents.ts:59`), replace the binary
  `readOnly ? readOnlyCapabilities(ui) : e.agent.capabilities` with:
  - `capabilities` supplied → scoped manager over that array;
  - else `readOnly:true` → scoped manager over the preset;
  - else → `e.agent.capabilities` (today's full inherit).
  If both `capabilities` and `readOnly` are supplied, `capabilities` wins and emit
  `e.log.warn` (design §4-D1 "Precedence").
- House rules: `.js` import specifiers; no `any`; `noUncheckedIndexedAccess`-safe
  indexing.

Acceptance:
```
node --import tsx --test test/subagents.test.ts
npm run typecheck
```

---

#### T4 — TEST: provider override hits the named provider / falls back on a miss

**Invariant protected (D2/AC-3, AC-4): a named, *registered* provider runs the
child (de-correlation); an unregistered/typo'd name falls back to the parent's
provider/model with a logged warning — never a hard failure.**

- **AC-3:** Register two providers — the default `mock` (parent) and a second
  under name `critic`. Because `MockProvider.name` is fixed to `"mock"`
  (`providers/mock.ts:39`), register the second via a thin subclass/rename so its
  `.name === "critic"` (design §5 "Offline-test assumption"). Give each a
  per-provider call-counter or a sentinel reply. Spawn with `provider:"critic"`;
  assert the *critic* provider's `stream` was invoked for the child and the parent
  provider was **not** (for that child request).
- **AC-4:** Spawn with `provider:"nope"`; assert the child ran on the **parent**
  provider (parent counter incremented, no throw) and an `e.log.warn` fired —
  capture warnings by passing a custom `logger` into `makeHarness` (the harness
  accepts `logger`; `helpers.ts:28`) whose `warn` pushes to an array.

Acceptance (failing — feature absent):
```
node --import tsx --test test/subagents.test.ts
```

---

#### T5 — IMPL: validate-and-fall-back provider/model override

**Makes T4 pass.** (Design D2.)

- Add `provider` (string) and `model` (string) to `spawn_agent` `parameters`.
- In `makeChild`, resolve the child's provider name: if `args.provider` is a
  string and `e.agent.providers.get(args.provider)` is **not** `undefined`, use it;
  otherwise fall back to `e.agent.providerName` and, when a name was supplied but
  unregistered, emit `e.log.warn` (design D2/AC-4). `model` is overridden only when
  `args.model` is a string; else `e.agent.model`. Pass the resolved
  `provider`/`model` straight into the `Agent` constructor (`agent.ts:40-41`,`:93`).
- Do not throw on an unknown provider name — graceful degradation is the contract
  (design §4-D2 "Why hard-require was rejected").

Acceptance:
```
node --import tsx --test test/subagents.test.ts
npm run typecheck
```

---

#### T6 — TEST: typed return validates; one re-prompt then fail; invalid→valid rescues

**Invariant protected (D3/AC-5, AC-6): the child's final JSON is validated against
`outputSchema` via `validate.ts`; a valid object reaches the parent in result
`details`; an invalid return triggers exactly **one** re-prompt seeded with the
errors, and a still-invalid return fails the call with a `contract violation:`
message — never an unbounded loop (at most two child runs).**

- **AC-5:** Spawn with
  `outputSchema = { type:"object", properties:{ status:{type:"string"},
  confidence:{type:"number"} }, required:["status","confidence"] }`. Script the
  child to emit `{"status":"ok","confidence":0.9}` (as its final assistant text).
  Assert the tool result is **not** an error and the parsed object is in the
  result `details` (`status === "ok"`, `confidence === 0.9` after coercion).
- **AC-6a:** Script the child to emit invalid JSON (prose) on turn 1 and
  *still*-invalid on the re-prompt. Assert the child was run exactly **twice** (a
  per-run counter == 2) and the final result `isError === true` with content
  matching `/contract violation/`.
- **AC-6b:** Script invalid-then-valid; assert the result is **not** an error (the
  single re-prompt rescued it).
- Optionally exercise `require:["status","confidence"]` folding into the schema's
  `required` (design D3) with a case that omits a required key.

Acceptance (failing — feature absent):
```
node --import tsx --test test/subagents.test.ts
```

---

#### T7 — IMPL: typed return with one error-keyed re-prompt

**Makes T6 pass.** (Design D3; reuses `validate.ts`; recovery-style single nudge.)

- Add `outputSchema` (object/JSONSchema) and `require` (array of strings) to
  `spawn_agent` `parameters`.
- When `outputSchema` is supplied: fold `require` into `outputSchema.required`
  (union), append a fixed contract instruction to the child's `systemPrompt`
  (e.g. `"Return ONLY a JSON object matching this schema: <schema>; required:
  <keys>"` — the wording is a fixed constant, design §4-D7 closing note), then run
  the child. Parse its final text as JSON; treat `JSON.parse` failure as a
  validation miss (design §5). Validate the parsed value with
  `validate(outputSchema, parsed)`.
  - On `ok`: return the validated object in the result `details` and a string
    rendering as `content` (the channel `finalText`/`renderResult` already use,
    design §3 "No streaming…").
  - On a miss: re-`run` the child **once**, seeding the re-prompt with the
    `errors` array from `validate()` (recovery posture). Validate again.
  - Still invalid after the single re-prompt: fail the call with a
    `contract violation:` message — **at most two child runs total** (design D3,
    "a hard, testable bound").
- When `outputSchema` is omitted: the child's `systemPrompt` is untouched and the
  return is the free-text `finalText` exactly as today (design §8 "schema text
  leaks" mitigation; locks T1/AC-7).
- Use only the existing `validate.ts` — **no new validator, no JSON-Schema
  features it lacks** (design §3 "No new validator").

Acceptance:
```
node --import tsx --test test/subagents.test.ts
npm run typecheck
```

---

#### T8 — TEST: workflow `agent`-step parity (AC-1 / AC-3 / AC-5 inside the DAG)

**Invariant protected (D6/AC-8): a `run_workflow` `agent` step carrying
`capabilities` / `provider` / `outputSchema` exhibits the same scoping,
de-correlation, and typed-return behavior as a standalone `spawn_agent`.**

- In `test/dynamic-workflow.test.ts`, add cases driving an `agent` step (reuse the
  `parentEmits` + `workflowHarness` helpers there, `:44-106`):
  - one assertion that `capabilities` on the step scopes the child (AC-1 inside the
    DAG);
  - one that `provider:"critic"` routes the child to the named provider (AC-3);
  - one that `outputSchema` validates the child's JSON and surfaces it (AC-5),
    with the step's rendered result reflecting the typed answer.

Acceptance (failing — parity feature absent):
```
node --import tsx --test test/dynamic-workflow.test.ts
```

---

#### T9 — IMPL: route the workflow `agent` step through the same child-builder logic

**Makes T8 pass.** (Design D6.)

- Extend `STEP_SCHEMA` (`dynamic-workflow.ts:63-87`) with the same optional
  `capabilities` / `provider` / `model` / `outputSchema` / `require` fields, and
  carry them onto the `WorkflowStep` (extend the interface, `:47-55`) during
  planning (`planWorkflow`, `:153`).
- In `runAgentStep` (`:435-454`), build the child with the **same** capability
  resolution (scoped subset vs. parent inherit), provider/model
  validate-and-fall-back, and typed-return-with-one-reprompt logic as the spawn
  path. Define the resolution once and call it from both call sites (design D6:
  "the three behaviors are defined once"). The simplest faithful approach: factor
  the shared resolution into small pure helpers usable by both files (e.g. a
  capability-manager-from-args helper and a provider-name resolver), keeping each
  file's `Agent` construction local. Do **not** widen kernel exports.
- The kill-switch gate (T11) must apply here too: with `EAGENT_SUBAGENTS_LP=off`,
  the `agent` step ignores the new fields and behaves as `dynamic-workflow` does
  today.
- The DAG scheduler, guard sequence, `${id}` substitution, skip cascade, and
  sequential-mode handling are **unchanged** (design §3 "No change to `mode`
  semantics … or to the workflow DAG scheduler").

Acceptance:
```
node --import tsx --test test/dynamic-workflow.test.ts
npm run typecheck
```

---

#### T10 — TEST: kill switch makes the new params a no-op

**Invariant protected (§2/§8/AC-9): with `EAGENT_SUBAGENTS_LP=off`, a spawn
supplying all three params behaves as plain `subagents` — the scoped denial does
NOT occur.**

- Take an otherwise-identical AC-1 setup (child with `capabilities:["shell:exec"]`
  trying to `mutate`). Set `process.env.EAGENT_SUBAGENTS_LP = "off"` for the
  duration of the test (set in a `try`, restore in `finally` so it never leaks to
  other tests — offline-suite hygiene). Assert the `mutate` flag flips (no
  scoped denial) under `fallback:"allow"`, proving the new param was ignored.

Acceptance (failing — kill switch not yet wired):
```
node --import tsx --test test/subagents.test.ts
```

---

#### T11 — IMPL: wire the `EAGENT_SUBAGENTS_LP` kill switch + TEST: clean unload (AC-10, edit-in-place equivalent)

**Makes T10 pass and adds AC-10's positive teardown assertion.** (Design §2
"Kill switch", §8; AC-10 via the §0 callout.)

- At the top of `subagents`' and `dynamic-workflow`'s `activate`, read
  `const lp = process.env.EAGENT_SUBAGENTS_LP !== "off"`. Gate **only** the new
  param handling on `lp`; when off, the capability/provider/typed-return branches
  are bypassed and the child is built exactly as before this task. The original
  spawn/workflow behavior is identical regardless of `lp`.
- Both `activate`s today return `void` (`subagents.ts:43`,
  `dynamic-workflow.ts:104`); the host synthesizes teardown from the registrations
  each tracks (`extension.ts:88-89`,`:255`). The kill switch is a boolean gate, not
  an early `return () => {}` — so **do not introduce a throwing teardown** (the
  house "dispose loop never throws" rule means: if you ever add a returned
  deactivate, wrap it; here you add none, so leave both returning `void`). There is
  no pre-existing dispose loop in either file to "keep intact."
- **AC-10 positive assertion (edit-in-place equivalent of the design's
  shadow-restore).** In `test/subagents.test.ts`, add a test that `host.use`s the
  modified `subagents`, confirms `agent.tools.get("spawn_agent")` is present, then
  `await host.unload("subagents")` and asserts: the unload resolves without
  throwing **and** `agent.tools.get("spawn_agent")` is now `undefined` (the host
  removed the registration, so a post-unload spawn is unavailable/inert). Add the
  mirror for `dynamic-workflow` / `run_workflow` in
  `test/dynamic-workflow.test.ts`. This replaces — not supplements — the design's
  shadow-restore assertion, which is moot in the edit-in-place shape (§0 callout).

Acceptance:
```
node --import tsx --test test/subagents.test.ts test/dynamic-workflow.test.ts
npm run typecheck
```

---

#### T12 — IMPL: document the three new params in `/agents` help

**Invariant protected (§2 Deliverable): the `/agents` command documents the three
new params.**

- Extend the existing `/agents` command body (`subagents.ts:180-190`) and the
  `spawn_agent` tool `description` with one line each for the capability
  allowlist, provider/model override, and typed return. The existing `/agents`
  test (`subagents.test.ts:295`) must stay green; optionally add an assertion that
  the new lines appear.

Acceptance:
```
node --import tsx --test test/subagents.test.ts
```

---

#### T13 — Exit gate: full offline suite + typecheck (AC-11)

**Invariant protected (AC-11): the whole suite passes offline, no network, no
`ANTHROPIC_API_KEY`; nothing prior regressed.**

Acceptance (all exit 0):
```
node --import tsx --test test/subagents.test.ts test/dynamic-workflow.test.ts
npm run typecheck
npm test
```

### Exit condition

- T1…T12 tests present and green (including T11's AC-10 unload assertions for
  both `subagents` and `dynamic-workflow`); T0 baseline tests still green.
- `node --import tsx --test test/subagents.test.ts test/dynamic-workflow.test.ts`
  passes.
- `npm run typecheck` exits 0.
- `npm test` exits 0 (full offline suite; existing `subagents`/`dynamic-workflow`
  tests stay green — the D4/AC-7 regression contract holds).
- Only these files changed: `src/extensions/subagents.ts`,
  `src/extensions/dynamic-workflow.ts`, `test/subagents.test.ts`,
  `test/dynamic-workflow.test.ts`, and this implementation doc. **`src/host.ts`,
  `CLAUDE.md`, `README.md` untouched; README count not bumped.**

---

## 3. Engineering Constraints Index (house rules + commit conventions)

House rules (from `CLAUDE.md` and the repo's `tsconfig` / batch conventions, all
of which a fresh agent can read directly; all enforced):

- **ESM + NodeNext.** Always use `.js` import specifiers even when importing a
  `.ts` file (e.g. `import { validate } from "../kernel/validate.js"`).
- **Strict TypeScript.** `strict`, `noUncheckedIndexedAccess`,
  `noImplicitOverride`, `noFallthroughCasesInSwitch` on. **No `any`** — model the
  types. Index access must be `noUncheckedIndexedAccess`-safe.
- **Zero runtime deps except `jiti`.** Pure Node + existing kernel modules only.
  Use the existing `validate.ts`, `CapabilityManager`, `ProviderRegistry`,
  `Agent` — add nothing.
- **Capability-gated side effects; offline `node:test`.** No new capability is
  added (an allowlist only *narrows*; design §3, D5). Tests run offline against
  the scriptable `MockProvider` via `makeHarness` (`test/helpers.ts:27`); no
  network, no API key.
- **Kill switch.** `EAGENT_SUBAGENTS_LP=off` makes the new behavior a no-op
  (design §8).
- **No throwing teardown.** Both target `activate`s return `void`
  (`subagents.ts:43`, `dynamic-workflow.ts:104`); the host synthesizes teardown
  from their tracked registrations (`extension.ts:88-89`,`:255`). Add no returned
  deactivate here — leave them returning `void`; if one were ever added, wrap it so
  it cannot throw (the general "dispose loop never throws" rule, e.g.
  `recovery.ts:107-113`). T11 asserts the host's unload of each is clean (AC-10).
- **Simplicity-first / no new requirements.** Introduce nothing absent from the
  design: no unbounded retries (exactly one re-prompt, D3), no new JSON-Schema
  features (D5/§3), no recursion-depth change (the single-omission guard stays,
  §3), no `mode`/DAG-scheduler change (§3).
- **Batch mode.** Do not edit `src/host.ts`, `CLAUDE.md`, `README.md`; do not bump
  the README extension count (those are *deferred to batch integration*).

Commit conventions (the repo's standard batch convention, consistent with
`CLAUDE.md`'s commit policy):

- Prefix with `feat(phase1)` for forward work and `fix(phase1-roundR)` for
  review-round fixes (`R` = the review round number).
- Add `npm test` and `npm run typecheck` results as commit-message **trailers**
  (e.g. `npm test: pass`, `npm run typecheck: pass`).
- **No mention of AI/model/tooling** in commit messages.
- Standard repo trailer policy from `CLAUDE.md` applies to commit messages; commit
  or push only when the user asks, and branch first if on the default branch.

---

## 4. Data / Fixture Dependencies

- **Reuse `test/helpers.ts`** — `makeHarness({ fallback?, ui?, logger? })`
  (`:27`) builds the offline `Agent` + `ExtensionHost` + default `MockProvider`;
  `lastText(agent)` (`:47`) reads a transcript's final assistant text. Pass a
  custom `logger` (the harness accepts one, `:28`) whose `warn` pushes to an array
  to capture the AC-4 fallback warning.
- **`MockProvider`** (`src/providers/mock.ts`) — scriptable via a responder
  function `(req, turnIndex) => MockTurn | undefined`; branch on
  `req.systemPrompt.includes("CHILD")` (spawn) / `"WF_CHILD"` (workflow) to script
  the child vs. the parent, exactly as the existing tests do. Its `.name` is fixed
  to `"mock"`, so the **second provider** for AC-3/AC-8 must be a thin
  subclass/rename whose `.name === "critic"` (design §5 "Offline-test
  assumption"). Per-provider call-counters or sentinel replies prove which
  provider a child reached.
- **Existing test scaffolding to reuse, not re-write:**
  - `subagents.test.ts`: `lastUserText`, `toolResults`, `mutateTool`
    (`:228`, an `fs:write` tool that flips a flag), `spawnAndMutate`
    (`:244`). Add a `lint` tool declaring `shell:exec` in the same style for
    AC-1.
  - `dynamic-workflow.test.ts`: `parentEmits` (`:44`), `wfResult` (`:36`),
    `workflowHarness` (`:96`), `recorder` (`:71`).
- **No new fixture files, no on-disk data.** Everything is in-memory and scripted
  (offline-suite rule). Do not read real files or hit the network.

---

## 5. Regression Protection — which prior tests MUST stay green

The whole suite stays green (AC-11); the load-bearing pre-existing tests this work
must not break:

- **`test/subagents.test.ts` (all current tests):** single/parallel/chain modes,
  the prompt-shape validation, both recursion-guard tests, the
  `readOnlyCapabilities` test (`:216` — T3's generalization must preserve it
  byte-for-byte), `"a readOnly child's fs:write tool is denied…"` (`:267`),
  `"a default (non-readOnly) child shares the parent's capabilities and may
  mutate"` (`:282` — the AC-7 "none-supplied == today" anchor), and `/agents`
  help (`:295` — T12 must keep it green).
- **`test/dynamic-workflow.test.ts` (all current tests):** the substitution
  primitives (T1/`extractRefs`/`substitute`), up-front validation (AC-5/6/9), data
  flow (AC-1/2), the **guard-sequence mirror** tests (AC-4/AC-7/7b/7c — these prove
  the workflow does not bypass capability/policy; T9 must not disturb them),
  `workflowChildRegistry` (AC-10), diamond fail-fast (AC-8), sequential-vs-parallel
  (AC-11). T9 only *adds* fields to `STEP_SCHEMA` and *enhances* `runAgentStep`; it
  must leave `runToolStep`/`guardedInvoke`/`guardedBody`/`runWorkflow`/
  `cascadeSkips`/`renderResult` untouched.
- **Full `npm test`:** every other extension/primitive suite must remain green —
  the kill switch and the additive params mean default behavior is unchanged, so
  no other suite should move. If any non-target suite changes, treat it as a
  regression to fix, not to accept.
- **Recursion guard preserved:** `childRegistryFrom` / `workflowChildRegistry`
  stay single-omission; a child still cannot spawn (design §3). Do not touch them.

**The regression floor is T0:** capture `npm test` + `npm run typecheck` green
before editing, and re-run both at every task boundary. Any drift in a pre-existing
test is a stop-the-line signal.
