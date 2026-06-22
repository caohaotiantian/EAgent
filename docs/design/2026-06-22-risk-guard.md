# Design: `risk-guard` — LLM-based semantic risk analyzer

Slug: `2026-06-22-risk-guard`
Status: draft

## 1. Background and Purpose

EAgent's security vocabulary is **capabilities**, enforced statically before a
tool runs, plus three policy guards on the `beforeToolCall` seam:

- `flow-guard` — taints a session on a source capability / sensitive data and
  holds egress (a *compositional* check; structural, no semantics).
- `bash-policy` — reduces a shell command to a command family and matches an
  allow/deny/ask ruleset (a *lexical* check; no semantics).
- `write-guard` — prompts before a blind overwrite (a *structural* check).

All three are **provider-free and pattern-based**. None can judge the *meaning*
of a specific invocation. `bash-policy` can say "the `rm` family is ask-listed",
but it cannot distinguish `rm /tmp/scratch.txt` from `rm -rf /` or
`rm -rf "$HOME"`; it cannot see that a `curl … | sh` pipes a remote script into a
shell, or that a particular `bash` line quietly exfiltrates `~/.aws/credentials`
to a pastebin. That semantic gap is exactly what OpenHands fills with an
`LLMSecurityAnalyzer` + a `ConfirmRisky` confirmation policy: classify the
proposed action with the model, and only prompt the human when the model judges
it risky.

This design ports that idea as a single, off-by-default extension: a
`beforeToolCall` guard that, for invocations of *sensitive-capability* tools,
asks the model to classify the specific call as SAFE or RISKY and, on RISKY,
either prompts the human (`ask` mode) or blocks (`block` mode).

What happens if we do not build it: semantic-intent risk that no static rule
encodes — destructive commands, obfuscated exfiltration, dangerous one-liners —
passes the existing guards whenever it stays within the allowed capability and
command-family envelope.

## 2. Deliverables

- [x] `src/extensions/risk-guard.ts` — a `beforeToolCall` guard that classifies
      sensitive-capability tool calls via a recursion-safe provider sub-call and
      blocks/asks on a RISKY verdict.
- [x] A `/risk-guard` command: `on | off | ask | block | status`.
- [x] Off-by-default gating: disabled unless explicitly enabled, plus an
      `EAGENT_RISK_GUARD=off` hard kill switch (consistent with the other guards'
      env switches).
- [x] Registration in `src/host.ts` `BUILTIN_EXTENSIONS`.
- [x] `test/risk-guard.test.ts` — offline `node:test` suite (scripted
      `MockProvider` verdicts) covering: risky→block, risky→ask(allow/deny),
      safe→pass, out-of-scope→no provider call, already-blocked passthrough,
      disabled→no call, analyzer-failure fallback, registration, command.
- [x] One inventory line in `CLAUDE.md` "Where things live".

## 3. Scope Boundary (NOT in scope)

- **Does not replace** capabilities, `flow-guard`, `bash-policy`, or
  `write-guard`. It is an additive, defense-in-depth layer that runs alongside
  them on the same `beforeToolCall` seam.
- **No verdict caching** across calls. Each in-scope call is classified
  independently in v1. (A name+args verdict cache is a possible later
  optimization; omitted now for Simplicity First.)
- **No structured/function-calling classification.** The sub-call passes
  `tools: []` and parses a short text verdict (see Decision 4.4). No JSON-schema
  tool is defined for the classifier.
- **No argument rewriting.** The guard only blocks/asks/passes; it never mutates
  `decision.arguments` (the `ToolDecision.arguments` rewrite path is unused).
- **No per-tool fine-grained policy** beyond the configured sensitive-capability
  scope set. Which tools are analyzed is decided solely by capability
  membership, not a per-tool ruleset (that is `bash-policy`'s job for shell).
- **Not on by default.** Because it makes a paid model call per in-scope tool
  call, it ships disabled and must be turned on explicitly (Decision 4.2).
- **No new capability** is declared (Decision 4.6).
- **No analysis of tool *results*** (only the proposed call, pre-execution).

## 4. Key Design Decisions

### 4.1 Where it hooks and how it scopes which calls to analyze

- **Problem**: classifying *every* tool call with an LLM is prohibitively slow
  and expensive; most calls (a `read`, a `glob`) are obviously safe.
- **Options**:
  1. Analyze every `beforeToolCall`.
  2. Analyze only calls to tools whose declared `capabilities` intersect a
     configured "sensitive" set (default `["shell:exec"]`).
  3. A per-tool-name allowlist of tools to analyze.
- **Choice**: option 2. On `beforeToolCall`, read the tool's capabilities via
  `e.agent.tools.get(ctx.call.name)?.capabilities ?? []` (the exact accessor
  `flow-guard` uses, `flow-guard.ts:114`); analyze only if that set intersects
  the configured `sensitiveCaps` (default `["shell:exec"]`, store-overridable).
- **Rationale**: Option 1 puts a model round-trip in front of every tool — a
  non-starter for cost and latency, against EAgent's cheap-guard ethos. Option 3
  duplicates registry knowledge as a name list that drifts when tools are
  renamed/shadowed; capabilities are the project's actual security vocabulary, so
  scoping by capability (option 2) is both cheaper and more idiomatic. Defaulting
  to `shell:exec` targets the single highest-semantic-risk surface (arbitrary
  command execution) and mirrors `flow-guard`'s default source capability.

### 4.2 Default state — off, explicit opt-in

- **Problem**: should the guard run by default like `flow-guard`/`write-guard`?
- **Options**: (1) on by default; (2) off by default (explicit enable).
- **Choice**: option 2 — off by default. Enabled via `/risk-guard on` (store
  flag) ; hard-disabled by `EAGENT_RISK_GUARD=off` regardless of the store flag.
- **Rationale**: every other always-on guard is *provider-free*; this one makes a
  **paid, latency-adding model call** per in-scope tool call. Turning that on
  silently for every user would be a surprising default cost. `bash-policy` set
  the precedent of a security extension that is a "no-op by default". Off-by-
  default keeps Simplicity First and least-surprise; the capability layer and the
  free guards remain the always-on baseline.

### 4.3 Verdict action — `ask` vs `block` mode

- **Problem**: what happens on a RISKY verdict?
- **Options**: always block; always ask; a configurable mode.
- **Choice**: a `mode` of `ask` (default) or `block`, mirroring `flow-guard`'s
  two-mode shape exactly. `ask` → `await e.agent.ui.confirm(...)`; allow passes,
  deny blocks. `block` → return `{ ...decision, block: true, reason }`.
- **Rationale**: Consistency with `flow-guard` (`flow-guard.ts:175-179`) gives
  users one mental model across guards. `ask` is the safe default (a human sees
  the model's reason and decides); `block` suits unattended/CI runs.
- **`ask` with no interactive UI**: the kernel's default `ui.confirm` resolves
  `false` (`agent.ts`'s default UI), so on a host with no real UI wired, an `ask`
  RISKY verdict resolves *deny* and **blocks** the call. This is deliberate and
  consistent with `flow-guard`'s identical behavior: the *human-decision* step is
  fail-closed (a risky call with nobody to approve it is held), which does not
  contradict Decision 4.5 — 4.5's fail-*open* governs the **analyzer** path (we
  could not get a verdict), whereas here the analyzer *did* return RISKY and the
  approver is simply absent. `ask` is intended for interactive hosts; unattended
  hosts should use `block` (explicit) or leave the guard `off`.

### 4.4 Classifier protocol — short text verdict, parsed leniently

- **Problem**: how does the sub-call communicate SAFE vs RISKY?
- **Options**: (1) a structured function/tool call; (2) a constrained text reply
  parsed by the extension.
- **Choice**: option 2. A fixed system prompt instructs the model to reply on a
  single line beginning with `SAFE` or `RISKY`, optionally followed by `: <one
  short reason>`. The extension reads the first non-empty line, upper-cases its
  leading token, and treats it as RISKY **iff** that token is `RISKY`; anything
  else (including `SAFE`) is treated as not-risky. The reason (text after the
  first `:`) is surfaced in the confirm prompt / block reason. A reply with no
  `:` (e.g. `RISKY (deletes home)`) is still a valid verdict with an empty
  reason — a missing colon is **not** a parse failure and must not route to the
  fail-open path; only an empty/garbled reply whose leading token is neither
  `SAFE` nor `RISKY` is treated as not-risky per Decision 4.5.
- **Rationale**: Simplicity First and zero-dep parsing. A structured tool call
  (option 1) would require defining a classifier tool and threading it through a
  provider that may map function-calling differently — overkill for a binary
  verdict. The **fail-toward-not-risky on an unrecognized token** is deliberate:
  an ambiguous/garbled reply must not silently block legitimate work (this guard
  is advisory defense-in-depth, not the primary gate — see Decision 4.5).

### 4.5 Failure handling — fail open, logged

- **Problem**: what if there is no provider, the sub-call throws, or the reply is
  empty/garbled?
- **Options**: (1) fail open (treat as not-risky, let the call proceed);
  (2) fail closed (block); (3) fall back to asking the human.
- **Choice**: option 1 — fail open, with `e.log.warn`. The call proceeds as if
  the verdict were SAFE.
- **Rationale**: `risk-guard` is an **additive advisory** layer on top of the
  always-on capability checks and free guards; a provider hiccup must not brick
  the agent (fail closed, option 2) nor nag on every call (option 3). The primary
  static gates still apply on the same seam, so failing open here does not remove
  the baseline protection — it only forgoes the *extra* semantic check for that
  one call. The warning makes the degradation observable. (This trade-off is the
  most security-relevant decision; it is recorded here so a future tightening to
  fail-closed is a conscious change, not a silent default.)

### 4.6 No new capability; recursion safety

- **Problem**: the guard calls the provider — does it need a capability, and can
  it recurse?
- **Choice**: no new capability (like `memory.ts`'s summarization sub-call, which
  declares none). The classification `provider.stream({ tools: [], … })` passes
  **no tools** and runs outside the agent loop, so it cannot itself emit a tool
  call and therefore cannot re-enter `beforeToolCall` — no recursion guard beyond
  "pass no tools" is needed.
- **Rationale**: the guard performs no filesystem/network side effect of its own;
  it reads tool metadata, calls the model read-only, and calls `ui.confirm`.
  That is the same privilege profile as `memory.ts` (`memory.ts:78-93`), which is
  capability-free. Passing `tools: []` is the exact recursion-safety mechanism
  `memory.ts` relies on.

## 5. Dependencies and Assumptions

- Kernel `beforeToolCall` filter and `ToolDecision` (`src/kernel/events.ts:40-58`).
- `ExtensionAPI`: `e.hook`, `e.registerCommand`, `e.store`, `e.log`,
  `e.agent.tools.get`, `e.agent.providers.get`, `e.agent.model`, `e.agent.ui.confirm`.
- The recursion-safe provider sub-call pattern from `memory.ts:78-93`
  (`provider.stream({ systemPrompt, messages, tools: [], model, signal })`,
  read the `done` event's message text).
- `MockProvider` is scriptable/deterministic, so classifier verdicts are scripted
  in tests — the suite stays offline with no API key (the house rule).
- No new npm dependency (jiti-only rule holds); Node built-ins only if any.

## 6. Relationship with Existing Designs

- `src/extensions/flow-guard.ts` is the structural sibling: same `beforeToolCall`
  seam, same `ask`/`block` two-mode shape (`flow-guard.ts:175-179`), same
  `capsOf` accessor (`flow-guard.ts:114`), same store-config + env-kill-switch +
  `/flow-guard`-style command. `risk-guard` reuses these patterns. The two are
  **complementary, not overlapping**: `flow-guard` judges *capability/data
  composition* across calls; `risk-guard` judges the *semantic content of one
  call*. No conflict.
- `src/extensions/bash-policy.ts` is the closest in intent (it gates shell), but
  it is *lexical* (command-family matching). `risk-guard` is *semantic* and not
  shell-specific (it scopes by capability, so any future `shell:exec`-bearing
  tool is covered). They stack: `bash-policy` can allow a family that
  `risk-guard` then flags on the specific argument string. No conflict.
- `src/extensions/memory.ts` establishes the capability-free, recursion-safe
  provider sub-call (`memory.ts:78-93`) this design reuses verbatim in shape.
- `docs/design/2026-06-20-bash-policy.md` and the `flow-guard` source are the
  terminology anchors (guard, mode, capability, taint). No prior design is
  superseded; this is a new, parallel guard. Terminology anchor: CLAUDE.md
  "House conventions" (capabilities are the security vocabulary).

## 7. Acceptance Criteria

All verified offline by `npm test` against a scripted `MockProvider` (no network,
no API key). Each is an assertion in `test/risk-guard.test.ts` unless noted. The
guard's `beforeToolCall` handler is exercised directly and/or through the harness.

1. **Risky → block mode blocks**: with the guard enabled in `block` mode and a
   `MockProvider` scripted to reply `RISKY: deletes the home directory`, calling
   the handler for an in-scope (`shell:exec`) tool returns a decision with
   `block === true` and a `reason` that includes the model's reason text.
2. **Risky → ask mode**: enabled, `ask` mode, provider scripted `RISKY: …`. The
   handler calls `ui.confirm` exactly once; when the UI answers **no**, the
   returned decision has `block === true`; when the UI answers **yes**, the
   decision passes (`block === false`).
3. **Safe → pass, no prompt**: enabled, provider scripted `SAFE`, in-scope tool.
   The returned decision is unchanged (`block === false`) and `ui.confirm` is
   **not** called.
4. **Out-of-scope tool → no provider call**: enabled, but the call targets a tool
   whose capabilities do **not** intersect `sensitiveCaps` (e.g. an `fs:read`-only
   tool). The provider's classification method is **never invoked** (assert a
   call counter is 0) and the decision passes.
5. **Already-blocked passthrough**: an input decision with `block === true`
   (an upstream guard already vetoed) is returned untouched and triggers **no**
   provider call.
6. **Disabled → no call**: with the guard disabled (default state, or
   `EAGENT_RISK_GUARD=off`, saved/restored in `finally`), an in-scope risky call
   makes **no** provider call and passes.
7. **Analyzer failure → fail open**: enabled, in-scope tool, but the provider is
   absent (or its `stream` throws / yields an empty/garbled verdict). The handler
   returns a passing decision (`block === false`), does not throw, and a warning
   is logged. (Verified via a provider stub that throws and via one that yields a
   non-`RISKY`/`SAFE` line.)
8. **Registration**: activating the extension via the harness adds exactly **one**
   `beforeToolCall` listener and **one** command, and **zero** tools (delta
   assertions, per `prune.test.ts:222-233`).
9. **Command**: `/risk-guard on|off|ask|block` mutates the stored state and
   `status` prints the enabled flag, mode, and `sensitiveCaps`; an in-scope risky
   call is gated only after `on`. No throw on any subcommand. (Registration
   delta-assertion is analogous to `prune.test.ts:222-233`, adapted from the
   `transformContext` listener count to the `beforeToolCall` listener count.)
10. **Quality budget**: `npm run typecheck` exits 0 and the full `npm test` exits
    0 (`# fail 0`, 0 skipped) with the new suite included. No latency budget is
    declared because the guard is off by default and, when on, performs exactly
    one bounded model round-trip only for in-scope calls — the cost is the
    explicit, opted-into behavior, not a hot-path regression. (Documented here,
    consistent with `flow-guard`, which declares none.)

## 8. Risks and Rollback

- **Risk: cost/latency surprise.** *Mitigation*: off by default (4.2) and
  capability-scoped (4.1), so the model call happens only for explicitly-enabled,
  in-scope (default `shell:exec`) calls. The `EAGENT_RISK_GUARD=off` switch is an
  absolute override.
- **Risk: model misclassification** (false SAFE lets a risky call through; false
  RISKY nags). *Mitigation*: it is additive — a false SAFE still faces the static
  guards; a false RISKY in `ask` mode shows the human the reason to overrule.
  This is a known limitation of LLM-judging, surfaced here, not a correctness bug.
- **Risk: fail-open hides a provider outage**, silently dropping the semantic
  check. *Mitigation*: `e.log.warn` on every fallback makes it observable;
  Decision 4.5 records the trade-off so tightening to fail-closed is a conscious
  future choice.
- **Risk: recursion / re-entrancy** from the sub-call. *Mitigation*: the
  classification call passes `tools: []` and runs outside the agent loop, so it
  cannot emit a tool call or re-enter `beforeToolCall` (4.6).
- **Risk: blocking the analyzer thread on `ui.confirm`** in a non-interactive
  host. *Mitigation*: `ask` mode delegates to the same `e.agent.ui.confirm` every
  guard uses; `block` mode is the recommended setting for unattended runs and is
  documented in `/risk-guard status`.
- **Rollback**: a single self-contained extension plus one `BUILTIN_EXTENSIONS`
  line. Removing the line, `/risk-guard off`, `EAGENT_RISK_GUARD=off`, or
  deleting `src/extensions/risk-guard.ts` + its test disables/removes it with
  zero effect on other extensions. No schema/storage/protocol change.

## Closure note

Status: closed. Closing-commit: PENDING_SHA. Closed-on: 2026-06-22.
Acceptance: `npm test` exit 0 (400/400 pass, 0 skipped, incl. the 15 new
`risk-guard` tests), `npm run typecheck` exit 0,
`node --import tsx --test test/risk-guard.test.ts` exit 0 (15/15).
E2E / behavior gate: triggered (new `/risk-guard` command + new `beforeToolCall`
gating). Paid external run skipped — `AUTH_FAIL: no ANTHROPIC_API_KEY /
OPENAI_API_KEY / GEMINI_API_KEY set`; substituted with a MockProvider behavior
smoke through the real `createAgentHost` wiring (SMOKE-PASS: `/risk-guard`
registered and toggled off→on/block with `sensitive=shell:exec`; a `RISKY`-
classified `rm -rf /` shell call was BLOCKED — the tool never executed — and the
model saw the block reason; classifier consulted only for the in-scope call)
plus the full offline suite.
Reviews: L1 design pass (3 rounds), L2 impl pass (3 rounds), L3
dev→review→accept (review clean first round; one non-behavioral doc-comment fix
`fix(phase1)`; accept-pass), F whole-change correctness review pass (zero severe;
2 non-blocking cosmetic notes: a `parseVerdict` comment line-wrap, and AC-7(b)
asserting warn-count vs substring while AC-7(a) asserts the substring on the same
warn path — intentionally retained).
Deferred: none.
