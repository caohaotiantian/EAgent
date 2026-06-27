# Design — Phase 0 Foundation Pack

```
Status: closed
Closing-commit: 6332771
Closed-on: 2026-06-28
Deferred: finding — limits.ts:207 cache-token budget (RW1-1, docs/DEFERRED-FOLLOWUPS.md);
          finding — trace.ts:206 cached-token split display (RW1-2, docs/DEFERRED-FOLLOWUPS.md)
```

**Slug:** `2026-06-28-phase0-foundation` · **Wave:** 1 · **Mode:** Full
**Source roadmap:** [`docs/ROADMAP.md`](../ROADMAP.md) · **Strategy:** [`design/2026-06-28-eagent-redesign-blueprint.md`](2026-06-28-eagent-redesign-blueprint.md)

## 1. Background and Purpose

The re-design will deepen three load-bearing kernel seams (Waves 2-5). Each edits the agent loop
and can silently break the 52 capability-gated extensions, mis-price the oracle boundary, or let
malformed tool args reach `execute()`. Phase 0 builds the **regression net + cheap correctness,
security, and observability fixes** that make every later kernel edit safe to land.

If we skip it: a loop refactor that drops or breaks dozens of extensions passes CI today (no test
loads the canonical `BUILTIN_EXTENSIONS` set — `integration.test.ts` hand-maintains a divergent
18-item list and `createAgentHost` swallows activation errors, `host.ts:236-242`); cached turns stay
mispriced (cache tokens folded into `inputTokens`, `anthropic.ts:153-154`); an MCP tool can exfiltrate
past `flow-guard` (egress set lacks `mcp:call`, `flow-guard.ts:36`); malformed-but-typed args reach
tools (`validate.ts` ignores `additionalProperties`/min-max/pattern and rejects coercible numeric
enums, `validate.ts:30`); and an unbounded `Promise.all` wave (`agent.ts:324`) can 429-storm.

## 2. Deliverables

- [ ] **P0.1** `BUILTIN_EXTENSIONS` CI gate: `createAgentHost` records per-extension activation
  failures on the returned `AgentHost` (additive, runtime stays log-and-skip); a host test loads the
  real set and asserts `loaded == BUILTIN_EXTENSIONS.length`, `failures.length === 0`, and no
  duplicate tool/command names.
- [ ] **P0.2** `Usage` gains additive optional fields `cacheReadTokens?`, `cacheWriteTokens?`,
  `reasoningTokens?`; `inputTokens` redefined as **non-cached** input; `outputTokens` **always
  includes** reasoning (Gemini's disjoint `thoughtsTokenCount` is folded into `outputTokens`), with
  `reasoningTokens` an informational subset; `addUsage`/`totalTokens` updated (and `addUsage` preserves
  the 2-field shape when neither operand carries cache/reasoning); anthropic/openai/gemini providers
  populate the new fields; `cost.ts` prices cache reads/writes at reduced/premium multipliers;
  `budget-cap.ts` budgets on a cache-aware total.
- [ ] **P0.3** Add `mcp:call` to each guard's existing default **in place** (not via one shared
  constant): `flow-guard` egress → `["net:fetch","mcp:call"]`; `secret-guard` leak →
  `["net:fetch","shell:exec","mcp:call"]`. `flow-guard`'s `shell:exec` stays in its **source** set,
  never egress. `content-guard` foreign set already consistent (`["net:fetch","mcp:call","mcp:read"]`).
- [ ] **P0.4** `validate.ts` enforces (only when the schema declares them) `additionalProperties:false`,
  numeric `minimum`/`maximum`, string `minLength`/`maxLength`/`pattern`, and evaluates `enum` **after**
  coercion; the agent loop re-validates `decided.arguments` as the single gate so a guard that *fixes*
  invalid args is honored (`agent.ts:359` early-reject removed).
- [ ] **P0.5** `Agent` gains a `maxConcurrency` option + mutable field; `dispatch` honors it via a
  bounded worker pool while preserving requested result order; default preserves current behavior.
- [ ] Tests for each; `kernel-surface.test.ts` updated if the public surface or line ceiling moves.

## 3. Scope Boundary (NOT in scope)

- **No** `transformRequest` (Wave 2), snapshot/fork (Wave 4), or `onProviderError` (Wave 5).
- **No** full provenance/taint system — P0.3 is *only* the capability-set unification, not arg-taint.
- **No** spec-complete JSON-Schema validator — only the listed keywords, kept a "minimal subset".
- **No** change to the kernel's *default* concurrency policy beyond providing the mechanism; setting
  a finite cap is a host/extension policy decision (deferred to Wave 5 reliability ext).
- **No** new runtime dependency (zero-deps-but-jiti holds); **no** new exported kernel symbol unless
  required (Usage field additions are interface-internal).
- **No** shared/extracted guard capability constant and **no** restructure of the guards: P0.3 only
  appends `mcp:call` to each guard's *own* existing default in place (KDD-4). `flow-guard`'s `shell:exec`
  stays in its **source** set and must **never** enter its egress set.
- **No** change to `dynamic-workflow.ts`'s near-verbatim copy of `executeGuarded` (`dynamic-workflow.ts:439-459`,
  including its own early-reject-before-revalidate and "(after guards)" message). The KDD-6 fix applies to
  the **kernel** loop only; reconciling the duplicate is a deferred follow-up, not Wave 1 (avoids a
  drive-by edit and a false "fix incomplete" reading).

## 4. Key Design Decisions

### KDD-1 — `Usage` extension shape
*Problem:* `Usage` carries only `inputTokens`/`outputTokens`, so cache and reasoning tokens are
invisible. *Options:* (a) add optional fields `cacheReadTokens?`/`cacheWriteTokens?`/`reasoningTokens?`;
(b) a nested `UsageDetail` object; (c) a generic `extra: Record<string,number>`. *Choice:* **(a)**.
Additive, typed, keeps `addUsage` a flat sum, and the existing `{inputTokens,outputTokens}` literals
across the code still type-check (new fields optional). *Constraint (applies to `addUsage`, the per-turn payload, AND each provider
mapping):* the optional fields must be **omitted** when not reported, so a `{inputTokens,
outputTokens}` value stays deep-equal to the same 2-field object today — a new `cacheReadTokens: 0`
must not appear. This is load-bearing for existing `deepEqual` assertions on provider-emitted Usage
(`test/anthropic.test.ts:69`, `test/openai.test.ts:60`, `test/gemini.test.ts:52`, all 2-field), not
just for the `MockProvider`. *Rejected:* (b) churns every call site and the mock; (c) loses type safety and
can't be pinned by tests.

### KDD-2 — Cache-token accounting semantics
*Problem:* Should `inputTokens` keep folding cache reads in (`anthropic.ts:153-154`)? *Options:*
(a) `inputTokens` stays "all billed input incl. cache", add cache fields as informational sub-totals;
(b) `inputTokens` becomes **fresh/non-cached** input, with `cacheReadTokens`/`cacheWriteTokens` as
disjoint siblings; `totalTokens = inputTokens + cacheRead + cacheWrite + outputTokens`. *Choice:* **(b)**.
It makes cost a clean weighted sum and matches how providers report (OpenAI/Gemini give cached as a
sub-field of prompt tokens; we subtract it out). *Rejected:* (a) forces every priced consumer to do a
subtract-and-rediscount dance and keeps the misleading "inputTokens includes cache" trap. *Risk noted:*
this changes the *meaning* of `inputTokens` in cost/budget displays — handled by updating those
consumers and their tests (Risks §8).

**Reasoning-token rule (per-provider, decided here — not deferred).** `outputTokens` is the canonical
**billable** output and **always includes** reasoning; `reasoningTokens` is an informational subset
(invariant `reasoningTokens ≤ outputTokens`, AC-4). The subset relation differs by provider, so the
mapping is provider-specific: **Anthropic** — thinking is already inside `output_tokens`; set
`reasoningTokens` from the thinking portion if exposed, else omit. **OpenAI** — `reasoning_tokens ⊆
completion_tokens`; `outputTokens = completion_tokens`, `reasoningTokens = reasoning_tokens`.
**Gemini** — `thoughtsTokenCount` is **disjoint** from `candidatesTokenCount` and additive to the
billed total, so fold it in: `outputTokens = candidatesTokenCount + thoughtsTokenCount`,
`reasoningTokens = thoughtsTokenCount`. This keeps the subset invariant true and prevents the Gemini
undercount.

### KDD-3 — Cache pricing in `cost.ts`
*Problem:* Cache reads cost a fraction of fresh input; writes a premium. *Options:* (a) ignore (status
quo, wrong); (b) add full per-provider `cacheReadPerMTok`/`cacheWritePerMTok` rate columns; (c) price
via standard multipliers (read ≈ 0.1×, write ≈ 1.25× input rate) applied to the existing input rate,
overridable per-row. *Choice:* **(c)**. `cost.ts` is explicitly an *estimator*; multipliers capture
the dominant effect in ~3 lines without doubling the rate table. *Rejected:* (b) over-engineers a table
that is already approximate; (a) leaves the original defect.

### KDD-4 — Guard egress/leak `mcp:call` fix (minimal, per-guard)
*Problem:* `flow-guard` egress (`["net:fetch"]`, `flow-guard.ts:36`) and `secret-guard` leak
(`["net:fetch","shell:exec"]`, `secret-guard.ts:52`) both omit `mcp:call`, so an MCP tool exfiltrates
unguarded. *Options:* (a) inline-add `mcp:call` to each guard's existing default; (b) one shared
exported constant both guards import as their default. *Choice:* **(a)** — `flow-guard` egress →
`["net:fetch","mcp:call"]`; `secret-guard` leak → `["net:fetch","shell:exec","mcp:call"]`; each still
store-overridable. *Rejected:* (b) is **wrong and harmful here**: `flow-guard` deliberately separates a
**source** set (`DEFAULT_SOURCE_CAPS=["shell:exec"]`, `flow-guard.ts:34` — caps that *taint* the
session) from its **egress** set (caps that *exfiltrate*). A shared union containing `shell:exec` would
make every shell command after the first be classified as egress while the session is tainted, so
`flow-guard` (on by default in ask mode) would prompt/block every subsequent shell call — a severe
regression. The two sets legitimately differ; `secret-guard` also documents a deliberate
copy-not-import decoupling (`secret-guard.ts:33-42`), so a shared `lib/` constant is rejected on both
counts. `content-guard`'s *foreign/ingress* set is a distinct concept (already
`["net:fetch","mcp:call","mcp:read"]`) and stays separate; only confirmed consistent.

### KDD-5 — Validator hardening boundary
*Problem:* How much JSON-Schema to add without breaking tools that rely on loose validation?
*Options:* (a) full spec; (b) only keywords that are inert unless the schema declares them. *Choice:*
**(b)** — enforce `additionalProperties:false`, `minimum`/`maximum`, `minLength`/`maxLength`, `pattern`
**only when present**, and move the `enum` check to after coercion. A schema that declares none behaves
exactly as today, so no existing tool regresses. *Rejected:* (a) violates the "minimal subset" contract
in `validate.ts:1-9` and risks breaking permissive tools.

### KDD-6 — Re-validate as the single gate (ordered before capability check)
*Problem:* `agent.ts:359` rejects originally-invalid args *before* the post-guard re-validate, so a
`beforeToolCall` guard that repairs args is ignored. *Options:* (a) keep early reject; (b) drop the
early `if (!ok)` reject and let the post-guard `validate(decided.arguments)` be the sole gate.
*Choice:* **(b)**, with two refinements surfaced by L1 review: **(i)** the single re-validate runs
**before** the capability `require` loop, so an irreparably-invalid call still fails *before* any
capability is requested (no spurious ask-prompt/audit entry for a call that will fail validation); and
**(ii)** the invalid-args error message is **unified** to one string (`"Invalid arguments for X:\n-
…"`) regardless of guard involvement, so the no-repair case is byte-identical to today's early-reject
text and existing error-text assertions do not break. *Rejected:* (a) makes guard arg-repair silently
dead.

### KDD-7 — Concurrency-cap default
*Problem:* A finite default would change current parallel-dispatch behavior. *Options:* (a) finite
default (e.g. 8); (b) default `Infinity` (mechanism only; byte-identical today), host/extension sets a
finite policy later. *Choice:* **(b)** — the kernel "ships zero opinions"; a cap is policy. Results are
already reassembled in requested order, so a later finite cap is correctness-neutral. To make
"unchanged when unset" a *guarantee* rather than a property of the pool implementation, `dispatch`
**fast-paths** the unbounded/default case to the literal `Promise.all(calls.map(runOne))` it uses
today and enters the bounded worker pool **only** when a finite `maxConcurrency` is set. *Rejected:*
(a) is a silent behavior change inside a foundation wave that aims to *preserve* behavior.

## 5. Dependencies and Assumptions

- No upstream wave dependency; Phase 0 is the foundation. Assumes `structuredClone`, `AbortSignal`,
  and global `fetch` (already used). Assumes the offline `MockProvider`/cassette suite remains the
  test substrate (no network). Provider cache/reasoning field names assumed per current APIs
  (Anthropic `cache_read_input_tokens`/`cache_creation_input_tokens`; OpenAI
  `prompt_tokens_details.cached_tokens` + `completion_tokens_details.reasoning_tokens`; Gemini
  `cachedContentTokenCount` + `thoughtsTokenCount`) — verified in L2 against provider parsing code.
  **Subset-vs-disjoint relation (recorded now):** OpenAI `cached_tokens`/`reasoning_tokens` are
  *sub-fields* (subtract cached out of `prompt_tokens`; reasoning lies within `completion_tokens`).
  Anthropic `cache_read`/`cache_creation` are *disjoint* from `input_tokens` (currently summed in);
  thinking lies within `output_tokens`. Gemini `cachedContentTokenCount` lies *within*
  `promptTokenCount` (subtract out), but `thoughtsTokenCount` is *disjoint* from `candidatesTokenCount`
  and additive to `totalTokenCount` — so it is folded into `outputTokens` (KDD-2).

## 6. Relationship with Existing Designs

Strategy parent: `design/2026-06-28-eagent-redesign-blueprint.md` (§3 Phase 0, §2.1). Terminology
anchors: CLAUDE.md (kernel primitives, capability vocabulary, house conventions) and the existing
source. Per the task's "code is the only source of truth" constraint the technical decisions are
grounded in current source, not in prose docs; the citations below are for coherence/supersession only.

Directly-overlapping prior designs:
- **`2026-06-22-cost.md` §D2 (parent / unblocks).** That design *deferred* cache-read/write and
  reasoning-token pricing because the kernel `Usage` then carried only input+output and adding fields
  was "a kernel-boundary change [out of scope]" (cost.md:72-75, §D2:125-130). KDD-2/KDD-3 here make
  exactly that additive kernel change, so this Phase **unblocks** cost.md's deferred D2.
- **`2026-06-20-incremental-prompt-cache.md` (related; breakpoints unchanged).** That design
  established the Anthropic cache **breakpoint placement** (system + last tool + last message), which
  this Phase leaves untouched. The separate **folding** of `cache_read`/`cache_creation` into
  `inputTokens` (`anthropic.ts:153-154`) is a provider-**code** behavior (introduced earlier, predating
  that design — so it is not that design's decision); KDD-2 reverses that **code** behavior so cache
  tokens become disjoint `Usage` fields. No conflict with the breakpoint design.

The pre-existing `docs/REDESIGN-NOTES.md`/`RESEARCH-*.md` are **not** treated as authority.

## 7. Acceptance Criteria (measurable, automatable)

- **AC-1** `npm run typecheck` exits 0.
- **AC-2** `npm test` exits 0 (all existing + new tests).
- **AC-3** New `test/host.test.ts` case: `createAgentHost({provider:'mock'})` loads exactly
  `BUILTIN_EXTENSIONS.length` extensions and the new `failures` field **on the object `createAgentHost`
  returns** (the `AgentHost`, not its `host` `ExtensionHost` property) is empty. Duplicate detection is
  **per-namespace and derived from the registries' `.list()`** (active definitions only): `agent.tools.list()`
  tool names have no dup; `commands.list()` command names have no dup. This respects the kernel's
  intentional command/tool *shadowing* (e.g. `skills` is registered by both `skills.ts` and
  `skills-hardening.ts`, `commands.ts:3`) — `.list()` returns one active entry per name, so legitimate
  shadowing is not a false positive. Note `respond` is registered by exactly one extension
  (`output-contract.ts`) so it never duplicates: its **command** is registered eagerly at activate
  (`output-contract.ts:198`, so it *is* in `commands.list()` on a fresh host) while its **tool** is
  registered lazily inside the `agent_start` handler only when an `outputSchema` is set
  (`output-contract.ts:151`, so it is absent from `tools.list()` on a fresh host) — either way, unique.
- **AC-4** New test: a simulated provider usage with cache + reasoning yields a `Usage` with disjoint
  `inputTokens`/`cacheReadTokens`/`cacheWriteTokens` and `reasoningTokens ≤ outputTokens`; `addUsage`
  sums all fields; `totalTokens` = input+cacheRead+cacheWrite+output.
- **AC-5** New `cost.ts` test: identical token totals priced with vs without cache differ — a turn with
  N cache-read tokens costs strictly less than the same N as fresh input.
- **AC-6** New `validate.ts` tests: `additionalProperties:false` rejects an extra key (and a schema
  omitting it still preserves unknown props); `maximum`/`minimum`/`minLength`/`maxLength`/`pattern` each
  reject a violating value and accept a conforming one; `{type:"integer", enum:[1,2,3]}` accepts the
  string `"2"` (coerced to `2` before the enum check).
- **AC-11** New per-provider usage-parsing tests (the riskiest part of P0.2): feed each of
  anthropic/openai/gemini a representative usage payload (cached + reasoning present) and assert the
  mapped `Usage` has the disjoint split per §5 — OpenAI `inputTokens = prompt - cached`,
  `cacheReadTokens = cached`; Gemini `outputTokens = candidates + thoughts`, `reasoningTokens =
  thoughts`, `inputTokens = prompt - cachedContent`; Anthropic `inputTokens = fresh input`,
  `cacheReadTokens`/`cacheWriteTokens` populated and no longer folded into `inputTokens`. The
  `prompt - cached` subtraction is clamped (`Math.max(0, …)`) defensively even though the API contract
  guarantees `cached ≤ prompt`.
- **AC-7** New `agent.test.ts` case: a `beforeToolCall` guard that rewrites an originally-invalid arg
  into a valid one results in the tool executing (not an invalid-args error).
- **AC-8** New `agent.test.ts` case (deterministic via a controlled barrier — each tool execution
  signals start then awaits release): with `maxConcurrency = 1` and 3 parallel-eligible tool calls, at
  most one execution is in-flight at any time and results are returned in requested order; with the
  default (unset) and the same barrier, all 3 reach in-flight concurrently (proving the fast-path runs
  them like `Promise.all`).
- **AC-9** New guard test: `flow-guard` egress default and `secret-guard` leak default both include
  `mcp:call`; an MCP-cap tool is treated as an egress sink by both.
- **AC-12** New `flow-guard` regression test (pins the round-1 severe out): with `flow-guard` enabled,
  a `shell:exec` tool call (tainting the session) followed by a **second** `shell:exec` call is **not**
  gated — i.e. `shell:exec` is absent from the egress default and stays a source-only cap.
- **AC-10** `kernel-surface.test.ts` passes: public export list unchanged (or intentionally updated)
  and `src/kernel/` stays strictly `< 2,200` lines (the test asserts `lines < 2200`).
- **AC-13** New `types.ts`/usage test pinning the omit-invariant: `addUsage({inputTokens,outputTokens},
  {inputTokens,outputTokens})` returns an object **deep-equal to a 2-field object** (no `cacheReadTokens`
  etc. key present), and `addUsage` of two cache-bearing usages sums each optional field.

*Quality budget:* no hot-path latency regression — the concurrency mechanism adds O(n) scheduling over
a tool wave (n = calls in a turn, typically <10); excluded from a numeric budget as negligible and
not user-facing beyond existing tool latency.

## 8. Risks and Rollback

- **R1 — `inputTokens` semantic change breaks token assertions** (cost/budget tests, and the
  `deepEqual` Usage assertions in `test/anthropic.test.ts:69`, `test/openai.test.ts:60`,
  `test/gemini.test.ts:52`). *Mitigation:* the omit-when-absent invariant (KDD-1) keeps the 2-field
  shape for payloads without cache/reasoning, so those three provider tests pass unchanged; update only
  the tests that intentionally exercise cache/reasoning. *Rollback:* the change is additive per-file;
  revert the provider/cost commits to restore folding.
- **R2 — Validator hardening breaks a permissive existing tool.** *Mitigation:* keywords are inert
  unless declared; full `npm test` over all 52 extensions is the gate (AC-2). *Rollback:* revert
  `validate.ts`; keywords are isolated additions.
- **R3 — `additionalProperties` interaction with current "preserve unknown props" behavior.**
  *Mitigation:* preserve-unknown stays the default; `false` only *rejects*, it does not change passthrough
  for schemas that omit it. *Rollback:* drop the `additionalProperties` branch.
- **R4 — Re-validate-as-single-gate changes an error path.** *Mitigation:* the invalid-args message is
  unified (KDD-6 (ii)) so the no-repair case keeps today's text byte-for-byte; the re-validate is
  ordered before the capability `require` (KDD-6 (i)) so no spurious capability prompt fires; AC-7 pins
  the guard-repair behavior and existing invalid-args tests must still pass. *Rollback:* restore the
  early reject.
- **R5 — Concurrency pool reorders results or perturbs ordering when unset.** *Mitigation:* `dispatch`
  fast-paths the default to the literal `Promise.all` (KDD-7) so unset behavior is unchanged by
  construction; when a finite cap is set the pool collects into an index-keyed array and AC-8 asserts
  requested-order output. *Rollback:* default `Infinity` already equals `Promise.all`.

Each deliverable is an independent commit, so any single P0.x can be reverted without the others.

## L1 Review Log

- **Round 1** — 2 severe (guard egress-set conflation regressing flow-guard; Gemini reasoning-token
  undercount) + 5 general + 4 clarifications. All addressed.
- **Round 2** — 1 severe (Scope-Boundary/KDD-4 contradiction + missing AC pinning shell:exec-not-egress)
  + 3 general (Usage omit-invariant scope; AC-3 namespace conflation; §6 prior-design citations) + 3
  clarifications. All addressed; AC-12 added.
- **Round 3** — **zero severe** (verdict pass) + 2 general (§6 folding provenance; AC-3 `respond`
  characterization) + 2 clarifications. Fixed; AC-13 added.
- **Round 4 (corroborating)** — run under the cap-convergence policy ([[three-loop-cap-convergence-policy]]):
  rounds 1-3 each carried general issues, so the strict two-generation rule cannot close within the
  3-round cap though the design has converged (round 3 zero-severe). Per the user-authorized policy a
  single corroborating round is auto-run; close iff clean. **Verdict: PASS — zero severe, zero general**
  (one cosmetic clarification: AC numbering is non-sequential, non-blocking). **L1 closed.**
