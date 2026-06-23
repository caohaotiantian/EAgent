# Design: `subagents-least-privilege` — per-spawn capability allowlist, provider override, typed return

Status: closed
Closing-commit: 308c239
Closed-on: 2026-06-23
Deferred: finding — D3 re-prompt mechanism + an AC test-citation were doc-imprecise (resolved in implementation; doc-precision)

Slug: `2026-06-22-subagents-least-privilege`

## 1. Background and Purpose

`subagents` (`src/extensions/subagents.ts`) is the extension that lets the model
spawn isolated child agents from the `spawn_agent` tool. It is deliberately
small, and that smallness has hardened into three concrete limits a parent
cannot work around today:

1. **Only two privilege lanes.** A spawned child either inherits the parent's
   *entire* capability manager (`capabilities: e.agent.capabilities`,
   `subagents.ts:62`) or runs in the single hardcoded `readOnly` lane
   (`readOnlyCapabilities`, `subagents.ts:202-204`) which grants exactly
   `fs:read` + `skill:read` and denies everything else by fallback
   (`READ_ONLY_GRANTS`, `subagents.ts:194`). There is no middle tier — no way to
   say "this child may read **and** lint (`shell:exec`) but must not write or
   fetch". `dynamic-workflow`'s `agent` step is worse: it *always* inherits the
   full parent manager (`dynamic-workflow.ts:439`), with no read-only lane at
   all.

2. **A hardcoded provider/model.** Every child is constructed with
   `provider: e.agent.providerName, model: e.agent.model`
   (`subagents.ts:65-66`; identically `dynamic-workflow.ts:442-443`). A critic
   or verifier child therefore runs on the *same vendor* as the work it
   reviews, so its errors are correlated with the producer's — exactly the
   failure mode a second opinion is supposed to break.

3. **A free-text return.** A child returns only its last assistant text via
   `finalText(messages)` (`subagents.ts:81`, `:227-235`; `dynamic-workflow.ts:450`,
   `:478-486`). The parent gets prose, with no machine-checkable status,
   confidence, or evidence — it cannot branch on a child's verdict without
   re-parsing English.

This extension adds **three small, optional, independently default-off**
passthroughs to `spawn_agent` (and the `dynamic-workflow` `agent` step) that
close exactly these three gaps, each by reusing machinery that already exists.
No kernel change, no new capability. When a `spawn_agent` call supplies none of
the three, its behavior is byte-identical to today.

The three:

- **(A) A capability allowlist** — `capabilities: [...]` scopes a child to an
  arbitrary capability *subset* (a fresh deny-fallback `CapabilityManager`
  granting only the listed patterns), generalizing the existing `readOnly`
  path. `readOnly: true` becomes sugar for the preset
  `["fs:read", "skill:read"]`.
- **(B) A provider/model override** — `provider` / `model` validated against
  `e.agent.providers.get(name)` (`src/kernel/registry.ts:73-75`), falling back
  to the parent's provider/model when unset or unregistered (logged).
- **(C) A typed return** — `outputSchema` (+ optional `require: [...]`) appends a
  contract instruction to the child's system prompt and validates the child's
  final JSON with the existing `validate()` (`src/kernel/validate.ts:19`),
  re-prompting the child **once** on a miss then failing the call with a clear
  contract-violation message.

## 2. Deliverables

- [ ] `src/extensions/subagents-least-privilege.ts` — the extension. It does
      **not** register a second `spawn_agent`; it shadows the spawn surface by
      replacing `subagents`' construction helpers. (See §4 D7 for the chosen
      shape: a self-contained extension that re-registers `spawn_agent` and the
      `run_workflow` `agent`-step behavior, gated behind the kill switch.)
      **Real cost — duplication, not a thin shadow:** the helpers this extension
      must rebuild are module-private. `subagents.ts` exports only
      `readOnlyCapabilities` + `childRegistryFrom`; `makeChild`/`runChild`/
      `finalText`/`asPrompts` are private (`subagents.ts:59-82`, `:220-235`).
      `dynamic-workflow.ts` exports only `MAX_STEPS`/`planWorkflow`/`extractRefs`/
      `substitute`/`workflowChildRegistry`; the whole executor —
      `runWorkflow`/`cascadeSkips`/`runStep`/`runToolStep`, the kernel
      **guard-sequence mirror** `guardedInvoke`/`guardedBody`
      (`dynamic-workflow.ts:391-433`), `runAgentStep`, and `renderResult` — is
      private (verified `grep '^export'`). Because §3/D7 forbid editing those two
      files (so we cannot widen their exports), re-registering `run_workflow`
      here means **re-implementing the entire DAG scheduler plus its
      guard-sequence mirror (~200 LoC)**, duplicating the very mirror
      `dynamic-workflow.ts:386-389` already flags "must be updated to match" on
      kernel drift. This is the design's real price and the implementer should
      expect it; the spawn-side shadow is genuinely thin, the workflow-side
      shadow is not. (D6/D7 weigh this against the parity benefit.)
- [ ] `test/subagents-least-privilege.test.ts` — offline `node:test` suite
      against `MockProvider`, loaded via `host.use(id, activate)` (per
      `test/recovery.test.ts:118-120`), **not** depending on
      `BUILTIN_EXTENSIONS`.
- [ ] Kill switch `EAGENT_SUBAGENTS_LP=off` — early-return no-op in `activate`,
      mirroring `recovery.ts:103`.
- [ ] `/agents-lp` command (or an extension to the `/agents` help text) that
      documents the three new params.
- [ ] `docs/design/2026-06-22-subagents-least-privilege.md` — this document.
- [ ] `docs/implementation/2026-06-22-subagents-least-privilege.md` — the
      implementation log, written at build time.
- [ ] host.ts registration in `BUILTIN_EXTENSIONS` — **(deferred to batch
      integration)**.
- [ ] CLAUDE.md / README inventory line + extension count — **(deferred to batch
      integration; do not bump the README count here)**. Reconciled at closeout.

## 3. Scope Boundary (NON-goals — Simplicity First)

- **No kernel change.** Everything composes the public `Agent` constructor, the
  `ProviderRegistry`, `CapabilityManager`, and `validate()` exactly as
  `subagents`/`dynamic-workflow` already do. **Caveat:** "composes the same
  primitives" is *not* "reuses the same code" — because the executor internals of
  both files are module-private and §3/D7 forbid widening their exports, the
  workflow-side shadow must **copy** `dynamic-workflow`'s DAG scheduler and
  guard-sequence mirror rather than call into it (see §2 "Real cost"). The reuse
  thesis holds at the primitive level; at the function level the workflow path is
  a deliberate duplication, accepted as the cost of staying new-files-only.
- **No new capability.** The existing `agent:spawn` (`subagents.ts:44`) /
  `workflow:run` (`dynamic-workflow.ts:105`) grants are unchanged. An allowlist
  *narrows* a child; it never grants the parent anything new.
- **No new validator.** The typed return reuses `src/kernel/validate.ts`
  verbatim. We do **not** add JSON-Schema features it lacks (no `oneOf`,
  `pattern`, `minLength`, etc.) and take no dependency on any other
  output-contract effort (none is landed in `docs/design/` today — §6); the
  child's return is validated here, self-contained.
- **No unbounded retries / no self-healing loop.** Exactly **one** re-prompt on
  a typed-return miss, then fail. Not a negotiation.
- **No recursion-depth changes.** The single-omission recursion guard
  (`childRegistryFrom`, `subagents.ts:210-217`) is preserved unchanged — a child
  still cannot spawn.
- **No grandchild provider inheritance policy, no per-mode provider, no
  per-child distinct allowlists in one call.** `system`/`provider`/`model`/
  `capabilities`/`outputSchema` apply uniformly to every child of one
  `spawn_agent` call, exactly as `system` already does (`subagents.ts:59`,
  `:148`). A heterogeneous fan-out is `mode=parallel` plus the DAG; that is
  `dynamic-workflow`'s job, not a new param matrix here.
- **No streaming of the child's structured object to the parent transcript.**
  The parent receives the validated JSON as the tool result's `content` (string)
  plus the parsed object in the result `details`, the same channel
  `finalText`/`renderResult` already use.
- **No change to `mode` semantics** (single/parallel/chain) or to the workflow
  DAG scheduler.

## 4. Key Design Decisions

### D1 — Capability allowlist: generalize the existing read-only path vs. a new mechanism

**Problem.** A child needs a privilege tier between "inherit everything" and the
single hardcoded read-only lane.

**Options.**
1. Generalize: build a fresh `CapabilityManager({ grant: allowlist, fallback:
   "deny", ui })` from a caller-supplied capability subset, and make `readOnly`
   sugar for the preset `["fs:read","skill:read"]`.
2. A new bespoke mechanism (e.g. a per-tool allowlist on the child registry, or
   a wrapper that filters `tools.list()` by declared capabilities).

**Choice: option 1.** The read-only lane *already is* this exact construction —
`readOnlyCapabilities` is `new CapabilityManager({ grant: [...READ_ONLY_GRANTS],
fallback: "deny", ui })` (`subagents.ts:202-204`). Generalizing it to an
arbitrary `grant` array is a one-line change in spirit: a child manager whose
`grant` is the caller's allowlist instead of the fixed two reads. `readOnly:
true` simply supplies that preset. (Note: "one-line change in spirit" scopes the
*manager construction* only — the allowlist itself is trivial. The cost of this
extension lives elsewhere, in re-registering the spawn/workflow surface to inject
that manager; see §2 "Real cost" and D7. D1 is not claiming the whole feature is
one line.)

**Why the alternatives were rejected.** A per-tool registry filter (option 2)
re-implements authorization in a *second* place — the dispatcher already
enforces `capabilities` via `capabilities.require(cap, name)`
(`agent.ts` guard sequence, mirrored at `dynamic-workflow.ts:414-416`). Filtering
the tool list instead would (a) duplicate the security decision, (b) diverge
from `isGranted` wildcard semantics (`capabilities.ts:144-152`), and (c) leave a
tool *present but unusable*, producing confusing "capability denied" errors
mid-run rather than a clean upfront scoping. Capabilities are EAgent's security
vocabulary (CLAUDE.md, "Capabilities are the security vocabulary"); scoping a
child to a capability subset is the idiomatic move, and reusing the proven
deny-fallback manager keeps the enforcement in one place.

**Precedence.** `capabilities: [...]` and `readOnly: true` both produce a scoped
manager. If both are supplied, `capabilities` wins (it is the explicit,
more-general form) and a warning is logged; if neither is supplied the child
inherits the parent manager exactly as today (`subagents.ts:62`).

### D2 — Provider override: validate-and-fall-back vs. hard-require

**Problem.** A child must be able to run on a *different* registered vendor to
de-correlate errors, without making a typo a hard failure.

**Options.**
1. Validate the requested name against `e.agent.providers.get(name)` and, if it
   returns `undefined`, fall back to the parent's
   `providerName`/`model` (logged via `e.log.warn`).
2. Hard-require: an unregistered/typo'd provider name fails the `spawn_agent`
   call.

**Choice: option 1 (validate-and-fall-back).** `ProviderRegistry.get(name)`
returns `undefined` for an unknown name (`registry.ts:73-75`). On `undefined` we
keep `provider: e.agent.providerName, model: e.agent.model` — today's exact
values — and emit a warning. A valid name flows straight into the `Agent`
constructor's `provider` field, which the loop already honors (`AgentOptions.provider`,
`agent.ts:40-41`, `:93`). `model` is overridden only when the caller supplies
it; otherwise the parent's `model` is used.

**Why hard-require was rejected.** A spawn is often a best-effort second opinion;
a hard failure on a misremembered provider name turns a degraded-but-useful run
into no run at all and surfaces as an opaque tool error to the model. Graceful
degradation (run on the parent's provider, warn for the operator) is strictly
more robust and loses nothing measurable: the de-correlation benefit only exists
when the name *is* registered, and when it is, both options behave identically.
The warning makes the fallback observable so a silent typo is still diagnosable.

### D3 — Typed return: one re-prompt then fail vs. unbounded retries

**Problem.** A child's final answer must be machine-checkable; an invalid return
should get one cheap correction, not an open-ended repair loop.

**Options.**
1. Validate the child's final text-as-JSON with `validate(outputSchema, parsed)`
   (`validate.ts:19`); on a miss, `steer`/re-`run` the child **once** with the
   concrete validation errors, then validate again; if still invalid, fail the
   `spawn_agent` call with a contract-violation message.
2. Loop until valid (or until `maxTurns`/a retry budget).

**Choice: option 1 (one re-prompt then fail).** This mirrors the `recovery`
posture — one terse, mechanical, error-keyed nudge then move on
(`recovery.ts:1-22`). The re-prompt is the *same* child given a fresh run seeded
with the validation `errors` array from `validate()`. The contract instruction
("Return ONLY a JSON object matching this schema: …; required: …") is appended
to the child's `systemPrompt`, reusing `outputSchema` as the schema text.
`require: [...]` is folded into the schema's `required` before validation, so the
parent can demand specific keys (e.g. `["status","confidence"]`) without
hand-writing a full schema.

**Why unbounded retries were rejected.** Each retry is a full child `run`
(latency + tokens, live); an unbounded loop against a model that cannot satisfy
the schema is a cost sink with no termination guarantee, and "bounded and
predictable" is the EAgent house posture (cf. `maxTurns`, `MAX_STEPS`,
`limits`). One re-prompt captures the overwhelmingly common case (the model
emitted prose around the JSON, or dropped one field) while keeping a hard,
testable bound: at most two child runs per typed spawn, then a clean
`contract-violation` failure the parent can branch on.

### D4 — All three optional and default-off (backward compatibility)

**Problem.** Bundling three sub-features risks a "grab-bag" extension and risks
silently changing existing spawns.

**Options.**
1. Each of `capabilities` / `provider`+`model` / `outputSchema` is an *optional*
   `spawn_agent` param; omitting all three reproduces today's code path exactly
   (full-inherit manager, parent provider/model, free-text `finalText`).
2. Make the new behavior the default (e.g. always require a typed return, or
   always scope to read-only).

**Choice: option 1.** The branch is literally `args.capabilities === undefined &&
args.readOnly !== true ? e.agent.capabilities : scopedManager(...)`, etc. With
none supplied, the constructor arguments are identical to `subagents.ts:60-70`.
This is the rollback story (§8) and is asserted by a dedicated regression test
(§7 AC-7).

**Why "new behavior as default" was rejected.** It would break every existing
`spawn_agent` caller and every `subagents` test, violating Simplicity-First and
the "omitted → today's behavior exactly" contract in the spec. Default-off also
keeps the three features independent: a spawn using only the provider override
pays nothing for the allowlist or typed-return code paths.

### D5 — Reuse `e.agent.providers` + `validate.ts` + recovery-style re-prompt — no kernel change, no new capability

**Problem.** Where should the multi-vendor, schema, and retry machinery come
from?

**Options.**
1. Reuse three existing primitives: the provider registry
   (`e.agent.providers`, already multi-vendor — `registry.ts:56-84`), the
   validator (`validate.ts`), and a `recovery`-style single nudge.
2. Add new machinery (a child-spawn capability, a second validator tuned for
   return schemas, a retry primitive).

**Choice: option 1.** The registry already supports N registered providers and a
keyed `get` — multi-vendor is a *configuration*, not a missing feature. `validate`
already coerces/validates the exact JSON-Schema subset tool args use, which is
the same subset a return contract needs. The recovery extension already proves
the "one error-keyed nudge" pattern.

**Why new machinery was rejected.** A new capability is unjustified — spawning is
already gated by `agent:spawn`, and an allowlist only *narrows*, never widens,
authority (so it needs no grant of its own). A second validator would duplicate
`validate.ts` and drift from it. A retry primitive is over-engineering for a
fixed bound of one. Zero-new-primitive is the EAgent thesis (CLAUDE.md, "new
behavior is always an extension").

### D6 — Apply the same three to `dynamic-workflow`'s `agent` step (parity)

**Problem.** `dynamic-workflow`'s `agent` step hardcodes the same three limits
(`dynamic-workflow.ts:435-454`); leaving it behind splits the spawn surface.

**Options.**
1. Extend the workflow `STEP_SCHEMA` (`dynamic-workflow.ts:63-87`) with the same
   optional `capabilities` / `provider` / `model` / `outputSchema` / `require`
   fields and route an `agent` step through the same shared child-builder.
2. Only enhance `spawn_agent`, leaving workflow `agent` steps at full-inherit /
   parent-provider / free-text.

**Choice: option 1.** Parity is the point — a critic step inside a DAG wants the
same de-correlation and typed return as a standalone spawn. The shared builder
(see D7) is invoked from both call sites, so the three behaviors are defined
once.

**Why "spawn only" was rejected.** It would leave the *more* powerful
orchestration surface (the DAG) with the *weaker* child controls, pushing users
back to manual `spawn_agent` chaining to get a scoped/cross-vendor/typed critic —
the opposite of the convergence `dynamic-workflow` was built for
(`dynamic-workflow.ts:11-22`).

### D7 — Extension shape: shadow the spawn surface vs. fork `subagents`

**Problem.** This is a separate extension file (per the batch constraint), yet it
must change `spawn_agent`'s and the workflow `agent` step's behavior.

**Options.**
1. A self-contained extension that *re-registers* `spawn_agent` (the registry
   shadows by name, later-wins — `registry.ts:20-37`) and a `run_workflow` whose
   `agent` steps use the enhanced builder, both built from the same shared
   helper module; load order puts this after `subagents`/`dynamic-workflow` so it
   wins, and disposing it restores the originals (the registry's shadow-restore).
2. Edit `subagents.ts` / `dynamic-workflow.ts` in place.

**Choice: option 1 (shadow).** It honors the batch constraint (only new files
touched), keeps the enhancement hot-reloadable and independently disposable, and
uses the registry's documented shadow/restore semantics — the same mechanism
every extension relies on. The kill switch makes the extension a clean no-op, so
with `EAGENT_SUBAGENTS_LP=off` the original `subagents`/`dynamic-workflow`
registrations remain active and behavior is exactly today's.

**Cost of this choice, stated plainly.** Shadowing `run_workflow` is *not* a
one-line interception. The DAG scheduler and its guard-sequence mirror are
private to `dynamic-workflow.ts` (see §2 "Real cost"), and because forking is
ruled out (option 2) *and* widening that file's exports is equally ruled out by
the new-files-only batch rule, the workflow shadow must re-implement the
scheduler + mirror (~200 LoC). So the honest cost ledger is: option 2 (fork)
edits two existing files but writes no new scheduler; option 1 (shadow) writes a
new scheduler but edits no existing file. We take option 1 because disposability
+ hot-reload + the batch constraint outweigh the duplication — but D6/D7 own that
duplicated mirror, and it inherits `dynamic-workflow.ts:386-389`'s
"must be updated to match" obligation on kernel-guard drift (AC-8 exercises the
copied `beforeToolCall` path so drift surfaces as a failing test).

**Why in-place editing was rejected.** It is explicitly out of scope for this
batch (only `src/extensions/<name>.ts`, `test/<name>.ts`, `docs/` may change) and
would make the feature non-disposable as a unit. Shadowing is strictly more
Emacs-grade.

*(String/format sub-choices that self-justify as non-behavioral: the kill-switch
name `EAGENT_SUBAGENTS_LP`, the failure prefix `contract violation:`, and the
contract instruction wording are format choices with no behavioral fork; they are
fixed constants, not decisions among behaviors.)*

## 5. Dependencies and Assumptions

- **Depends on** the public `Agent` constructor accepting
  `{ providers, capabilities, ui, logger, model, provider, systemPrompt,
  maxTurns, tools }` (`AgentOptions`, `agent.ts:37-52`) — unchanged.
- **Depends on** `ProviderRegistry.get(name)` returning `undefined` for unknown
  names (`registry.ts:73-75`) for the validate-and-fall-back path.
- **Depends on** `CapabilityManager({ grant, fallback: "deny", ui })`
  semantics (`capabilities.ts:65-70`, `:85-120`) — a granted pattern allows, a
  fallback `deny` throws `CapabilityError` for anything else.
- **Depends on** `validate(schema, input)` returning `{ ok, value, errors }`
  with coercion (`validate.ts:19-23`).
- **Assumes** the recursion guard (`childRegistryFrom` / `workflowChildRegistry`)
  stays the single-omission design; the enhanced builder reuses it unchanged.
- **Assumes** a child's structured answer arrives as its final assistant *text*
  block (the same channel `finalText` reads, `subagents.ts:227-235`); the model
  is instructed to emit JSON there. `JSON.parse` failures are treated as a
  validation miss and trigger the one re-prompt.
- **Offline-test assumption:** `MockProvider` can be scripted per-vendor by
  registering two `MockProvider` instances under different names
  (`provider.name` is fixed to `"mock"`, so the test registers a second provider
  via a thin subclass/rename) and asserting which one a child's request reached.
- Zero new runtime dependencies (house rule). Pure Node + existing kernel
  modules.

## 6. Relationship with Existing Designs

Closest existing design (the contract this one generalizes):

- **`docs/design/2026-06-21-readonly-subagent.md`** (Status: **closed**,
  Closing-commit `08818d0`) — the predecessor that introduced the single
  `readOnly` lane this design generalizes. Its **explicit non-goal** was "No
  named-profile system. Exactly one lane (`readOnly`) ships." This design turns
  that shipped contract into **sugar over the new per-spawn allowlist**: `readOnly:
  true` becomes the preset `["fs:read","skill:read"]` (D1, §1). That is a
  deliberate *supersession by generalization* of a closed design's stated
  boundary, not a conflict — the `readOnly` keyword and its exact grants are
  preserved (AC-2 asserts byte-identical behavior), so nothing that predecessor
  shipped breaks; the "exactly one lane" boundary is simply lifted, on purpose,
  by adding the middle tier it explicitly deferred. Naming it here makes the
  relationship to that existing (closed) contract explicit.

Closest existing code (all read in full to ground this design):

- **`src/extensions/subagents.ts`** — the surface being enhanced: the
  `spawn_agent` tool (`:84-178`), `makeChild`/`runChild` construction
  (`:59-82`), `childRegistryFrom` recursion guard (`:210-217`),
  `readOnlyCapabilities` (`:194`, `:202-204`), the hardcoded
  `provider`/`model` (`:65-66`), and `finalText` harvesting (`:227-235`).
- **`src/extensions/dynamic-workflow.ts`** — the `agent` step
  (`runAgentStep`, `:435-454`) that hardcodes the same full-inherit manager,
  parent provider/model, and free-text `finalText` (`:478-486`); `STEP_SCHEMA`
  (`:63-87`) is the schema to extend for parity.
- **`src/kernel/validate.ts`** — the validator reused verbatim for the typed
  return (`validate`, `:19`).
- **`src/kernel/registry.ts`** — `ProviderRegistry.get` (`:73-75`), already
  multi-vendor, powering the override; `ToolRegistry` shadow/restore
  (`:19-53`) powering D7.
- **`src/extensions/recovery.ts`** — the precedent for the one-nudge,
  error-keyed, kill-switchable, deactivate-safe posture this extension copies
  (`:102-114`).

**De-duplication.** `subagents` already does spawn + the single read-only lane;
this adds the *missing middle privilege tier* (an arbitrary capability subset),
*cross-vendor de-correlation* (a per-spawn provider/model), and a *typed return
contract* (schema-validated child output) — none of which is expressible by the
current binary full-trust/read-only, single-provider, free-text-return design.
There is no overlap to remove: `readOnly` becomes sugar over the new allowlist
(D1), not a competing path.

**Conflict note.** There is **no landed output-contract design** in
`docs/design/` to conflict with: a `grep` for `outputSchema` / `output-contract`
/ `typed-return` / `return-schema` across `docs/design/` matches only this file
and the unrelated `2026-06-22-citations.md`. The typed return here is therefore
**self-contained by construction** — it validates a *child's* final JSON with
`validate.ts` directly and declares no dependency on any other task. If a
general output-contract design lands concurrently (the typed return is its
conceptual neighbor — a *tool's* declared output vs. a *child's* return), the two
do not collide: this one is scoped strictly to `spawn_agent` / `agent`-step
children and reuses the shared `validate.ts`, so a future contract design would
extend the same validator, not contend with a second one. No conflicts with any
existing design.

## 7. Acceptance Criteria

All measurable via `makeHarness` (`test/helpers.ts:27`) with scripted
`MockProvider` children, loaded via `host.use("subagents-least-privilege",
activate)` (per `test/recovery.test.ts:118-120`), **not** via
`BUILTIN_EXTENSIONS`.

- **AC-1 (allowlist denies outside / allows inside).** Register a `mutate` tool
  declaring `fs:write` and a `lint` tool declaring `shell:exec` (per
  `subagents.test.ts:228-241`). Spawn a child with `capabilities:
  ["shell:exec"]`; assert the child's `lint` call *runs* (flag flips) and its
  `mutate` call is *denied* (flag stays false, `CapabilityError` recorded). Run
  with `fallback: "allow"` on the parent so the denial is unambiguously the
  child manager's, not the parent's.
- **AC-2 (`readOnly` is sugar for the preset).** Spawn with `readOnly: true`;
  assert `fs:read` resolves and `fs:write`/`shell:exec`/`net:fetch` reject —
  identical to today's `readOnlyCapabilities` test
  (`subagents.test.ts:216-225`), proving the generalization preserves the preset.
- **AC-3 (provider override hits the named provider).** Register two providers,
  `mock` (parent default) and a second under name `critic`. Spawn with
  `provider: "critic"`; assert the *critic* provider's `stream` was invoked for
  the child (e.g. via a per-provider call-counter / a sentinel in its scripted
  reply) and the parent provider was not.
- **AC-4 (override falls back on unregistered name).** Spawn with `provider:
  "nope"`; assert the child ran on the *parent* provider (parent counter
  incremented, no throw) and an `e.log.warn` was emitted (capture via the
  harness logger).
- **AC-5 (typed return validates and returns a typed object).** Spawn with
  `outputSchema` = `{ type:"object", properties:{ status:{type:"string"},
  confidence:{type:"number"} }, required:["status","confidence"] }`. Script the
  child to emit `{"status":"ok","confidence":0.9}`; assert the tool result is
  **not** an error and the parsed object is present in the result `details`
  (`status === "ok"`, `confidence === 0.9` after coercion).
- **AC-6 (typed return re-prompts once then fails).** Script the child to emit
  invalid JSON (e.g. prose) on turn 1 and *still*-invalid on the re-prompt;
  assert the child was run exactly **twice** (re-prompt counter == 2) and the
  final tool result `isError === true` with content matching
  `/contract violation/`. A separate case: invalid then valid → result is *not*
  an error (the single re-prompt rescued it).
- **AC-7 (regression: none-supplied == today).** Spawn with *none* of
  `capabilities`/`readOnly`/`provider`/`model`/`outputSchema`; assert the child
  shared the parent manager (a parent-allowed `fs:write` runs — cf.
  `subagents.test.ts:282-293`), ran on the parent provider/model, and the tool
  result is the child's free-text `finalText` (no JSON contract applied) —
  byte-for-byte the pre-extension behavior.
- **AC-8 (workflow parity).** A `run_workflow` with an `agent` step carrying
  `capabilities` / `provider` / `outputSchema` exhibits AC-1/AC-3/AC-5 behavior
  inside the DAG (one assertion each), proving D6.
- **AC-9 (kill switch).** With `EAGENT_SUBAGENTS_LP=off`, loading the extension
  is a no-op: a spawn with all three params behaves as plain `subagents` (the
  new params are ignored / the original `spawn_agent` remains active). Assert by
  toggling the env var around an otherwise-identical AC-1 setup and observing the
  scoped denial does *not* occur.
- **AC-10 (clean teardown).** `host.unload("subagents-least-privilege")` restores
  the original `spawn_agent`/`run_workflow` registrations (registry
  shadow-restore) and throws nothing; a subsequent spawn behaves as plain
  `subagents`.
- **AC-11 (offline + typecheck).** `npm test` and `npm run typecheck` pass with
  no network and no `ANTHROPIC_API_KEY` (house rule); the new test file is fully
  offline against `MockProvider`.

## 8. Risks and Rollback

- **Risk: three features feel like a grab-bag.** Mitigation: each is an
  independent, optional, default-off param (D4); a spawn supplying none is
  byte-identical to today (AC-7). The three are unrelated code paths sharing only
  the child-builder, so none can regress the others.
- **Risk: typed-return overlap with a future output-contract design.**
  Mitigation: no such design is landed in `docs/design/` today (§6 conflict
  note), so there is nothing to depend on or collide with; this validates a
  *child's* return via `validate.ts` directly and is self-contained. Should a
  general output-contract design land, both extend the same shared `validate.ts`
  rather than introducing a second validator (D5), so they converge instead of
  conflict.
- **Risk: a child silently runs on the wrong provider after a typo.**
  Mitigation: validate-and-fall-back logs an `e.log.warn` (D2, AC-4), so the
  fallback is observable rather than silent.
- **Risk: schema text leaks into a child not built to emit JSON.** Mitigation:
  the contract instruction is appended *only* when `outputSchema` is supplied;
  with it omitted the child's `systemPrompt` is untouched (AC-7).
- **Risk: re-prompt cost.** Bounded to exactly one extra child run (D3, AC-6); no
  unbounded loop.
- **Risk: shadowing surprises (a third extension also shadowing
  `spawn_agent`).** Mitigation: registry shadow is later-wins with precise
  restore (`registry.ts:20-37`); `unload` restores cleanly (AC-10). Load order is
  controlled by the host's builtin set (batch step).

**Kill switch.** `EAGENT_SUBAGENTS_LP=off` makes `activate` an immediate no-op
(`return () => {}`, per `recovery.ts:103`): the original `subagents` /
`dynamic-workflow` registrations stay active and the system behaves exactly as
before this extension existed.

**Rollback.** All three behaviors are opt-in per call; omitting them is today's
behavior, and the kill switch / `host.unload` removes the extension wholesale
with the registry restoring the originals. No migration, no data, no schema
change to undo.
