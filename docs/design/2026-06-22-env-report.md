# Design: `env-report` extension — classify environmental failures and suppress the retry-nudge

Status: closed
Closing-commit: c7bfcaa
Closed-on: 2026-06-22
Deferred: none

Slug: `2026-06-22-env-report`

## 1. Background and Purpose

When a tool call fails, EAgent's `recovery` extension
(`src/extensions/recovery.ts`) rides the `afterToolCall` filter hook and appends
a terse corrective hint to the failed result so the model self-corrects instead
of looping. For *self-inflicted* errors — an `edit` whose `old` text is absent, a
schema-invalid argument set, a path outside the workspace — that nudge is exactly
right: the fix is mechanical and the *same call, corrected* makes progress.

But a class of failures is not self-inflicted and not correctable by retrying:
**environmental** faults. A missing `ANTHROPIC_API_KEY` or absent credential; a
binary that is not installed (`command not found`); a network/DNS/connection
failure; a filesystem permission denial. For these, the call is not "broken" in a
way the model can repair — the *environment* is broken. Re-issuing the identical
call (which is what a generic retry-nudge invites) is futile: it loops until the
run's call/token budget drains, accomplishing nothing. `recovery` itself does not
*match* these strings today (its `RECOVERY_RULES` are scoped to EAgent's own
error strings — `recovery.ts:42-73`), so it currently appends nothing for an env
fault. The risk this design addresses is twofold: (a) the model, left with a raw
env error and no guidance, often retries on its own anyway; and (b) as the
`recovery` ruleset grows, a future broad rule could begin nudging on env-shaped
errors. There is no host-visible signal that "this failure is environmental,
surface it to the operator and route around it" — which is precisely what
Devin's `report_environment_issue` does: classify the fault as environmental,
report it to the operator, and route *around* the infra (e.g. fall back to CI)
rather than burning turns trying to repair it in-loop.

This task digests that idea **as an extension** (never a kernel fork, per
`CLAUDE.md`). A new `env-report` extension rides the same `afterToolCall` filter
hook (`src/kernel/events.ts:59-63`, applied at `src/kernel/agent.ts:303`), and:

1. **Classifies** failed results against a small, conservative regex set scoped to
   clearly-environmental signals (auth/credential-missing, missing-binary,
   network/DNS/connection, permission-denied).
2. **Surfaces** an environment-issue signal the host/operator can see, via
   `e.log.warn` plus a `tool_end`-adjacent note, so an environmental blocker is
   not silently absorbed.
3. **Suppresses the retry-nudge** for env-class errors: by registering *after*
   `recovery` (filters run in registration order, each receiving the previous
   filter's output — `src/kernel/hooks.ts:64-65,86-88`), env-report sees any hint
   recovery already appended and, for an env-class error, **replaces** it with an
   *"environment issue: surface to the operator and route around; do NOT retry the
   same call"* note.

Plus an explicit `env_report` **tool** the model can call to declare an
environment blocker itself (the model-initiated path, mirroring Devin's tool).

If we do not do this, EAgent has no vocabulary for "this failure is the
environment, not the call" — env faults are indistinguishable from correctable
ones, the retry tax is paid on the one error class where retrying can never help,
and the operator gets no signal to fix the infra or route around it.

## 2. Deliverables

- [ ] `src/extensions/env-report.ts` — the extension: an `afterToolCall` guard
      that (a) classifies a *failed* result against an exported env-error ruleset,
      (b) on a match emits a host-visible `environment_issue` signal
      (`e.log.warn` + an appended note) and **replaces** any `recovery` hint with
      the route-around note; an `env_report` tool the model can call to declare a
      blocker; and an `EAGENT_ENV_REPORT=off` kill switch.
- [ ] An exported pure helper `classifyEnv(content: string): EnvClass | null`
      (returns the matched environmental class — `"auth"`, `"missing-binary"`,
      `"network"`, `"permission"` — or `null`) and an exported `ENV_RULES`
      constant; plus an exported `annotateEnv(result: ToolResult, kind?: EnvClass | null): ToolResult`
      guard transform (the optional `kind` lets the hook thread its
      already-computed verdict to avoid a second sweep; omitted, the transform
      self-classifies — the standalone single-arg contract is unchanged) — all
      unit-testable without the agent loop, mirroring
      `recovery`'s `recoveryHint`/`RECOVERY_RULES`/`annotate` seam
      (`recovery.ts:79-100`).
- [ ] `test/env-report.test.ts` — offline `node:test` tests against `MockProvider`
      via `makeHarness` (`test/helpers.ts`), co-loading `recovery` + `env-report`
      with inline stub tools that return env-class errors. Covers the pure
      classifier (each class, no-match, non-env error untouched), idempotency, the
      live guard through the agent loop (env error replaces recovery's nudge;
      non-env error keeps recovery's nudge; the `env_report` tool; the kill
      switch; clean disposal).
- [ ] **host.ts registration** — *(deferred to batch integration)*. Tests load the
      extension directly via `host.use("env-report", activate)` (the established
      offline pattern, e.g. `test/recovery.test.ts:120`) and do **not** depend on
      membership in `BUILTIN_EXTENSIONS`.
- [ ] An `env_report` command/tool surface: the model-callable `env_report` tool
      (registered via `e.registerTool`). No slash command is added (justified in
      D3 / Scope Boundary).
- [ ] **Kill switch** — `EAGENT_ENV_REPORT=off` returns a no-op disposer
      (mirroring `recovery.ts:103`, `circuit-breaker.ts:80`).
- [ ] **CLAUDE.md / README inventory line** — *(deferred to batch integration)*;
      the README extension count is **not** bumped in this task.

## 3. Scope Boundary (NOT in scope — Simplicity First)

- **No kernel change.** No new event type, no new filter, no change to
  `afterToolCall`'s signature (`ToolResult` in, `ToolResult` out —
  `events.ts:59-63`). The "environment_issue" signal is conveyed with existing
  primitives (`e.log.warn` + an appended marker in the returned `content`), not a
  new `KernelEvents` member. Adding a bespoke event would touch
  `src/kernel/events.ts` and every consumer's type — disproportionate for a
  per-failure annotation.
- **No LLM-based classification.** Detection is a fixed, conservative regex set
  (D2). No provider sub-call (unlike `risk-guard`), so the extension is
  deterministic, zero-cost, offline-testable, and cannot itself fail on a network
  fault — which would be self-defeating for a *network*-failure classifier.
- **No retry/route-around orchestration.** env-report *annotates and surfaces*; it
  does **not** itself switch to CI, retry on a different host, or mutate the
  agent's plan. Routing around is the operator's / model's decision; this
  extension only makes the env nature visible and tells the model not to retry.
- **No blocking.** env-report **never** sets `block: true` and never registers a
  `beforeToolCall` guard (D5). It rides only `afterToolCall` (observe/annotate)
  and registers a tool. It cannot veto or halt a call. A failed call still returns
  its result to the model; env-report only rewrites the *hint* portion.
- **No capability.** The extension has no privileged side effect (it reads result
  text and writes to the log/transcript), so it declares none — consistent with
  `recovery` and `circuit-breaker`. The `env_report` *tool* also needs no
  capability: declaring a blocker is a pure annotation with no host side effect.
- **No config/ruleset surface.** The env ruleset is a fixed exported constant (as
  `recovery`'s is — `recovery.ts:40`). No `e.store` keys, no `/env-report`
  command, no per-rule tuning. (Contrast `bash-policy`, which is intentionally
  configurable; env classification is not a per-host policy.)
- **No de-duplication of recovery's role.** env-report does **not** replace
  `recovery`; for non-env errors recovery's hint passes through untouched. The two
  compose (D1, §6).

## 4. Key Design Decisions

### D1. Coordinating with `recovery`: register *after* it and rewrite its hint for env-class errors

- **Problem:** When an env-class error occurs, `recovery` may have appended a
  retry-nudge (today its rules don't match env strings, but the design must be
  robust as that ruleset grows, and must in all cases guarantee the model ends up
  with the route-around note, not a retry-nudge). env-report must ensure the
  *final* annotation the model sees is "do not retry — route around", not "re-issue
  the call".
- **Options:**
  1. **A shared flag / cross-extension contract.** env-report sets a flag (e.g. an
     `e.store` key, or a field on the result `details`) that recovery reads to skip
     env errors. Requires editing `recovery.ts` to consult the flag, coupling two
     extensions, and a flag both must agree on.
  2. **Register env-report's `afterToolCall` filter *after* recovery's, and on an
     env-class error rewrite the result** — strip any appended recovery hint and
     replace it with the route-around note. Because filters run in registration
     order and each receives the prior filter's output
     (`src/kernel/hooks.ts:64-65,86-88`), env-report's filter sees the
     recovery-annotated `content` and can detect+replace recovery's
     `"Recovery hint:"` marker (`recovery.ts:34`).
- **Choice:** Option 2 — register-after-and-rewrite.
- **Rationale:** It is the simplest mechanism that works with the kernel as-is: no
  edit to `recovery.ts`, no shared mutable contract, no new kernel surface.
  recovery's hint lives in `result.content` behind a stable literal marker string
  (`MARKER = "Recovery hint:"`, `recovery.ts:34`). That `MARKER` is a module-private
  `const`, not an `export`, so env-report does **not** import it — it matches the
  literal `"Recovery hint:"` substring against recovery's verified append format
  (`${content}\n\n${MARKER} ${hint}`, `recovery.ts:99`), and can thereby
  deterministically locate and excise the hint (see §5). The ordering requirement (env-report registered after
  recovery) is the only coupling, and it is a documented load order, not a code
  dependency — env-report's correctness for the *replace* path relies on it, but
  its *classification + surfacing* works regardless of order. **Rejected Option 1**
  because a shared flag forces a change to `recovery.ts` (turning a self-contained
  extension into one that knows about env-report), introduces a contract both must
  maintain, and is strictly more code for no behavioral gain over reading the
  marker that already exists.

### D2. Env-error detection: a fixed conservative regex set, not an LLM classifier

- **Problem:** How does env-report decide a failed result is *environmental*?
- **Options:**
  1. **An LLM classifier** — a tool-less provider sub-call that reads the error and
     returns ENV / NOT-ENV (the shape `risk-guard` uses for risk).
  2. **A fixed regex set** matched against the failed result's `content`, scoped to
     clearly-environmental signals.
- **Choice:** Option 2 — a fixed regex set. Four classes, each a curated pattern:
  - **`auth`** — credential/key missing: e.g.
    `/(api[ _-]?key|credential|token)\b[^\n]*\b(missing|not set|unset|required|invalid|unauthorized)\b/i`
    (note: **no** leading `\b` — a leading word boundary would fail on
    prefixed identifiers like `ANTHROPIC_API_KEY`, since the `_` before `API`
    is itself a word character so no boundary exists there; the headline crit-2
    input `"Error: ANTHROPIC_API_KEY is not set"` must match),
    `/\b401\b|\bunauthorized\b|\bforbidden\b|\b403\b/i`,
    `/\bauthentication (failed|required)\b/i`.
  - **`missing-binary`** — absent executable: e.g.
    `/\bcommand not found\b/i`, `/: not found\b/i`,
    `/\bno such file or directory\b[^\n]*\b(bin|exec)\b/i`,
    `/\bENOENT\b[^\n]*\bspawn\b|\bspawn \w+ ENOENT\b/i`.
  - **`network`** — DNS/connection/network: e.g.
    `/\b(ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH)\b/i`,
    `/\b(getaddrinfo|dns) (failed|lookup)\b/i`,
    `/\bnetwork (is )?unreachable\b/i`, `/\bconnection (refused|timed out|reset)\b/i`.
  - **`permission`** — permission denial: e.g.
    `/\b(EACCES|EPERM)\b/i`, `/\bpermission denied\b/i`,
    `/\boperation not permitted\b/i`.
- **Rationale:** The patterns above are all **operating-system / runtime error
  vocabulary** (POSIX `errno` names, Node's `spawn ENOENT`, shell's
  `command not found`, HTTP 401/403), which are *stable, machine-emitted strings*
  — exactly what a deterministic matcher excels at, and which an LLM would only
  re-derive at the cost of a call. Option 2 is **deterministic, zero-cost, and
  offline-testable** (the house rule: every extension ships offline `node:test`
  tests against `MockProvider`). Crucially, an LLM classifier for *network*
  failures is self-defeating: classifying a network outage may itself require a
  network call. **Rejected Option 1** for that reason plus cost/latency/nondeterminism
  — `risk-guard` accepts those costs because semantic *risk* of an arbitrary shell
  command genuinely needs judgment; environmental error *shape* does not, it is a
  closed vocabulary of OS error codes. The patterns are deliberately
  **conservative** — anchored on unambiguous environmental tokens — to bound
  misclassification (R1); a borderline string that doesn't match simply gets
  recovery's normal behavior, the safe default.

### D3. Surfaces: automatic classification **and** an explicit `env_report` tool (both)

- **Problem:** Should env-report only auto-classify failures, or also expose a tool
  the model calls to *declare* an environment blocker?
- **Options:**
  1. **Automatic only** — the `afterToolCall` classifier, no tool.
  2. **Tool only** — a model-callable `env_report`, no auto-classification.
  3. **Both** — auto-classification *plus* an explicit `env_report` tool.
- **Choice:** Option 3 — both.
- **Rationale:** They cover disjoint cases. Auto-classification catches env faults
  the model would otherwise retry blindly (the model may not realize a `command not
  found` is environmental). The explicit tool covers the case Devin's
  `report_environment_issue` targets: the model has *diagnosed* a blocker (e.g.
  "this needs a `GITHUB_TOKEN` that isn't set") that no single tool result's text
  reveals, and wants to surface it to the operator and stop attempting the
  infra-dependent path. The tool is cheap — a small `defineTool` returning a
  success `ToolResult` whose content is the route-around note, plus the same
  `e.log.warn` host signal — and adds no capability. **Rejected Option 1** because
  it gives the model no way to *proactively* report a blocker it reasoned about
  rather than read from an error string. **Rejected Option 2** because it relies on
  the model to always recognize env faults, which the retry-loop problem proves it
  does not. No slash command is added: a `/env-report` command would be a human
  inspection surface with nothing to inspect (the extension holds no per-run state,
  unlike `circuit-breaker`'s buckets) — Simplicity First.

### D4. Shipping posture: on-by-default (lean like `recovery`), with `EAGENT_ENV_REPORT=off`

- **Problem:** Ship on-by-default, or opt-in/off-by-default?
- **Options:**
  1. **On by default** (like `recovery`, `circuit-breaker`, `write-guard`), kill
     switch `EAGENT_ENV_REPORT=off`.
  2. **Off by default** (like `risk-guard`), opt-in.
- **Choice:** Option 1 — on by default.
- **Rationale:** The posture should track *cost and safety of being wrong*.
  `risk-guard` is off-by-default because it makes a paid LLM call per sensitive
  tool and can *block*. env-report does neither: it is a zero-cost regex match that
  only *annotates* and *never blocks* (D5). Suppressing a futile retry on a clearly
  environmental fault is a strictly safe win — the worst case of a *correct*
  classification is the model routes around instead of looping; the worst case of a
  *misclassification* (R1) is the model gets a "don't retry, route around" note on
  an error that was actually transient, and it can still proceed (it is a hint, not
  a block). That asymmetry — large upside, bounded, non-fatal downside, zero cost —
  is exactly the profile that justifies on-by-default, the same reasoning
  `recovery` (`recovery.ts:16`) and `circuit-breaker` use. **Rejected Option 2**
  because off-by-default would leave the retry tax unpaid in the default
  configuration for a mechanism that is safe and free; opt-in is reserved for
  mechanisms that cost money or can block.

### D5. Posture on the call path: observe/annotate only — env-report must NEVER block

- **Problem:** Could env-report ever halt the call (e.g. block further attempts on
  an env fault)?
- **Options:**
  1. **Block** on an env-class error (register a `beforeToolCall` guard that vetoes
     repeats of an env-failing signature).
  2. **Observe/annotate only** — ride only `afterToolCall`, never set `block`.
- **Choice:** Option 2 — never block.
- **Rationale:** Blocking is a different extension's job. `circuit-breaker` already
  fail-fasts on *repetition* via `beforeToolCall` (`circuit-breaker.ts:113`); env
  classification's value is the *signal and the route-around hint*, delivered
  *before* repetition even starts, leaving the actual stop/continue decision to the
  model (and to `circuit-breaker` if the model ignores the hint and loops anyway).
  Keeping env-report purely `afterToolCall` also means it is **fail-open by
  construction**: every hook body wraps its logic in `try/catch` and returns the
  result unchanged on any internal error (the `trace.ts:88-96`/`circuit-breaker.ts:161`
  pattern), so a bug in the classifier can never wedge the agent. **Rejected Option
  1** because a blocking env-report would (a) duplicate `circuit-breaker`'s
  repetition role, (b) risk wedging the agent on a misclassification (turning R1
  from "a stray hint" into "a refused call"), and (c) contradict the "surface and
  route around, don't fight the infra" intent — blocking *is* fighting it.

## 5. Dependencies and Assumptions

- **`afterToolCall` filter hook** (`src/kernel/events.ts:59-63`, applied at
  `src/kernel/agent.ts:303`): `(ToolResult, { call }) => ToolResult`. Assumed
  stable; it is the exact hook `recovery` and `circuit-breaker` already use.
- **Filter execution order** (`src/kernel/hooks.ts:64-65,86-88`): filters run in
  registration order, each receiving the previous filter's output. D1's
  hint-rewrite depends on env-report being registered *after* recovery. In tests
  this is guaranteed by the `host.use("recovery", …)` then
  `host.use("env-report", …)` order (each `e.hook` call `push`es onto the
  per-point list — `hooks.ts:76`). In the deferred batch integration, env-report
  must be placed *after* recovery in `BUILTIN_EXTENSIONS`.
- **`recovery`'s hint marker** is the stable string `"Recovery hint:"`
  (`recovery.ts:34`). env-report detects and strips it. *Assumption:* this marker
  text is stable; if `recovery` changes its marker, env-report's strip step must
  track it. (It is exported as `MARKER` only implicitly — env-report will match the
  literal `"Recovery hint:"` substring; noted as a coupling in §6 and R2.)
- **`ToolResult` shape** (`src/kernel/types.ts:128-139`): `{ content: string;
  isError?: boolean; details?: unknown; terminate?: boolean }`. env-report gates on
  `isError === true` (like `recovery.ts:95`) and rewrites `content`; it never sets
  `terminate` or `block`.
- **`ExtensionAPI` surface** (`src/kernel/extension.ts:41-78`): `e.hook`,
  `e.registerTool`, `e.log` — all already used by `recovery`/`trace`/`circuit-breaker`.
  The host tracks every registration so disposal is clean (`extension.ts:219-241`).
- **`e.log.warn`** is the host-visible signal channel (`extension.ts:235` wires a
  prefixed logger; the default logger writes to `console.error` —
  `agent.ts:373-378`). The `environment_issue` "lifecycle signal" is `e.log.warn`
  + the appended `content` note; no new event type (per §3).
- **`defineTool`** (`src/kernel/define.ts:26`) + `ok` (`define.ts:42`) construct the
  `env_report` tool with an explicit JSON Schema.
- **Test harness** `makeHarness` (`test/helpers.ts:27`) + `MockProvider` responder
  scripting + inline stub tools (registered in a tiny inline activate, or via a
  co-loaded `defineTool`) drive the live tests **offline** — no network, no
  `ANTHROPIC_API_KEY`.
- **No new npm dependency** (jiti-only rule upheld; pure Node, regex only).

## 6. Relationship with Existing Designs

- **Closest: `recovery` (`src/extensions/recovery.ts`,
  `docs/design/2026-06-21-recovery-hooks.md`).** env-report is the deliberate
  *inverse* of recovery on the same `afterToolCall` hook. recovery turns a failed
  result into a **retry-nudge for the same call**; env-report classifies a *subset*
  of failures as environmental and does the opposite — **suppresses the retry-nudge
  and surfaces the fault to the operator**. They compose: env-report registers
  after recovery and rewrites recovery's hint *only* for env-class errors (D1);
  for every non-env error, recovery's hint passes through untouched. This is
  **adjacency, not conflict** — no shared mutable state, the only coupling is the
  documented load order and the literal `"Recovery hint:"` marker
  (`recovery.ts:34`). env-report also reuses recovery's **no-op-disposer kill-switch
  pattern** (`recovery.ts:103`) and its **exported-pure-helper test seam**
  (`recoveryHint`/`annotate` → `classifyEnv`/`annotateEnv`).
- **`circuit-breaker` (`src/extensions/circuit-breaker.ts`,
  `docs/design/2026-06-22-circuit-breaker.md`).** Both fight wasted retry loops, at
  different points. `circuit-breaker` fail-fasts on **repetition** (it trips after a
  signature recurs N times, via `beforeToolCall` — `circuit-breaker.ts:113`);
  env-report fail-fasts on **failure cause**, *before* repetition starts, via
  `afterToolCall` — it doesn't wait for the loop, it tells the model the first
  failure is environmental. They are complementary: env-report's hint aims to
  *prevent* the loop circuit-breaker would otherwise *catch*. No overlap in
  mechanism (env-report never touches `beforeToolCall`, never blocks — D5).
- **`trace` (`src/extensions/trace.ts`).** env-report borrows trace's
  **fail-open event-handler pattern** (`trace.ts:88-96`: wrap each hook body, log
  and return unchanged on error) for the `afterToolCall` guard, and trace's
  posture of being a pure observer that needs no kernel change.
- **`risk-guard` (`src/extensions/risk-guard.ts`).** Cited as the *contrast* for D2
  (LLM classifier) and D4 (off-by-default): risk-guard makes a paid provider
  sub-call and can block, so it is opt-in; env-report is deterministic, free, and
  non-blocking, so it is on-by-default. Distinct mechanism and posture; no shared
  code.
- **No conflict** with any existing extension: env-report adds one `afterToolCall`
  filter (composes with recovery's and circuit-breaker's by the order-preserving
  filter chain — `hooks.ts:86-88`) and one tool (a new name `env_report`, no
  shadow). First design to classify failures by *environmental cause* rather than
  by EAgent-internal error string (recovery) or by repetition (circuit-breaker).

## 7. Acceptance Criteria

All criteria are verified by `npm test` (offline) and `npm run typecheck`. Live
criteria co-load `recovery` then `env-report` (in that order, so the chain
ordering is real) plus inline stub tools that return scripted env-class /
non-env errors. Each criterion is a runnable assertion.

1. **Typecheck/build clean:** `npm run typecheck` exits 0 with the new files; no
   `any`, no unchecked index access (house strict-TS rules).
2. **Classifier — each env class (unit):** `classifyEnv` returns, by assertion:
   - `"auth"` for `"Error: ANTHROPIC_API_KEY is not set"` and for
     `"HTTP 401 Unauthorized"`,
   - `"missing-binary"` for `"/bin/sh: rg: command not found"` and for
     `"spawn rg ENOENT"`,
   - `"network"` for `"getaddrinfo ENOTFOUND api.example.com"` and for
     `"connect ECONNREFUSED 127.0.0.1:443"`,
   - `"permission"` for `"EACCES: permission denied, open '/etc/x'"`.
3. **Classifier — no false positive (unit):** `classifyEnv` returns `null` for a
   *self-inflicted* EAgent error string that `recovery` *does* match — e.g.
   `"Text not found in /tmp/x.ts."` and `"Invalid arguments for edit"` — proving
   env-report does not poach recovery's correctable cases.
4. **Classifier — benign output (unit):** `classifyEnv` returns `null` for a
   successful-shaped string (`"Wrote 12 bytes to /tmp/x.ts"`).
5. **Guard transform gating + idempotency (unit):** `annotateEnv` on a *success*
   result (`isError` falsy) returns it unchanged; on a *failed env-class* result it
   appends the route-around note exactly once (a second pass is a no-op — same
   idempotency contract as `recovery.ts:96`); on a *failed non-env* result it
   returns it unchanged.
6. **Hint replacement (unit):** given a failed env-class result whose `content`
   already carries a `"Recovery hint: …"` block (as recovery would have appended),
   `annotateEnv` returns content that (a) **no longer contains** `"Recovery hint:"`
   and (b) **does contain** the route-around marker (e.g.
   `/environment issue/i` and `/do NOT retry/i`).
7. **Live — env error replaces the retry-nudge:** with `recovery` then `env-report`
   loaded and a stub tool returning `{ isError: true, content: "spawn rg ENOENT" }`,
   the `tool_result` the model sees (a) matches the env route-around note and (b)
   does **not** match `/Recovery hint:/`. (Asserted by scanning the `tool`-role
   message blocks, the `recovery.ts:101-106` `sawHint` pattern, inverted.)
8. **Live — non-env error keeps recovery's nudge:** with the same two extensions
   loaded and a stub tool returning a recovery-matchable error
   (`{ isError: true, content: "Text not found in x.ts." }`), the `tool_result` the
   model sees **still** matches `/Recovery hint:/` and does **not** match the env
   note — proving env-report leaves correctable errors to recovery.
9. **Live — host signal emitted:** when a stub tool returns an env-class error, the
   logger passed to `makeHarness` records a `warn` line containing
   `"environment_issue"` (assert via a capturing logger that pushes its `warn` args
   to an array). Proves the operator-visible signal fires.
10. **Live — the `env_report` tool:** a scripted `MockProvider` that calls
    `env_report` with `{ reason: "GITHUB_TOKEN not set; cannot push" }` produces a
    *successful* `tool_result` whose content carries the route-around note, and the
    capturing logger records an `"environment_issue"` warn line.
11. **Kill switch:** with `EAGENT_ENV_REPORT=off`, an env-class error result is
    **not** rewritten (recovery's hint, if any, survives; no env note appears) and
    the `env_report` tool is **not** registered (`h.agent.tools.get("env_report")`
    is `undefined`).
12. **Clean disposal (no leak):** after `host.unload("env-report")`, a subsequent
    env-class error is not rewritten and `env_report` is gone — the `afterToolCall`
    hook and the tool were both disposed (the `recovery.ts:107-113` /
    `extension.ts:219-241` tracked-teardown contract).

No latency/throughput budget is declared: the guard runs a bounded set of
`RegExp.test` calls over one result string per failed tool call (microseconds),
off any hot loop — a performance budget is intentionally excluded per §3.

## 8. Risks and Rollback

- **R1 — Misclassifying a transient/retryable error as environmental.** A
  genuinely transient fault (a flaky network blip that *would* succeed on retry)
  matched by the `network` class gets a "do NOT retry, route around" note, possibly
  discouraging a retry that would have worked. *Mitigation:* (a) the patterns are
  **conservative**, anchored on unambiguous environmental tokens (POSIX `errno`
  names, `command not found`, HTTP 401/403) rather than generic words like "error"
  or "failed"; (b) the note is a **hint, not a block** (D5) — the model can still
  retry or route around as it judges; (c) `EAGENT_ENV_REPORT=off` is an instant
  escape hatch. The downside of a misclassification is bounded (a stray hint), not
  fatal (a refused call).
- **R2 — Ordering / marker coupling with `recovery`.** D1's hint-replacement
  depends on env-report being registered *after* recovery and on recovery's
  `"Recovery hint:"` marker (`recovery.ts:34`). If the load order is reversed, or
  recovery renames its marker, the *replace* step silently no-ops (env-report would
  still append its own note, but recovery's stale nudge could survive). *Mitigation:*
  the order is documented here and enforced in the deferred `BUILTIN_EXTENSIONS`
  placement (env-report after recovery); criterion 7 asserts the replace actually
  happened (fails loudly if the order/marker breaks); the marker is a single
  literal in one place. env-report's *classification + surfacing* (the operator
  signal) is **order-independent** and works even if the replace path no-ops.
- **R3 — Suppressing a useful nudge.** If env-report wrongly classifies an error
  that recovery *correctly* matched, it would strip a useful corrective hint.
  *Mitigation:* criterion 3 asserts `classifyEnv` returns `null` for recovery's own
  matchable strings (the two rulesets are disjoint by construction — recovery keys
  on EAgent-internal strings, env-report on OS error vocabulary); the env patterns
  do not overlap recovery's `RECOVERY_RULES` (`recovery.ts:42-73`).
- **Fail-open:** every hook body is `try/catch`-wrapped and returns the result
  unchanged on any internal error (the `trace.ts:88-96` pattern), so a classifier
  bug degrades to "no annotation", never to a broken agent.
- **Rollback:** `EAGENT_ENV_REPORT=off` (no-op disposer) or
  `host.unload("env-report")` fully disables it; the extension holds no persisted
  state and makes no migration. In batch integration, removing the one
  `BUILTIN_EXTENSIONS` line reverts it entirely. recovery's behavior is unchanged
  by env-report's absence (it never edited `recovery.ts` — D1).
