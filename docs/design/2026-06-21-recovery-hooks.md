# Design: `recovery` extension — turn tool errors into corrective nudges

Status: closed
Closing-commit: afccad3
Closed-on: 2026-06-21
Deferred: none

Slug: `2026-06-21-recovery-hooks`

## 1. Background and Purpose

When a tool call fails, EAgent today returns the raw error string to the model
and nothing else. The model then has to *infer* the fix from the error text —
and the common failure modes are exactly the ones where it re-issues the same
broken call: an `edit` whose `old` text is not found, an `edit` that matches in
several places, a tool call with arguments that miss the schema, a path that
escapes the workspace root. Each wasted retry burns a turn (and, against a live
provider, tokens and latency) on a mistake whose correction is mechanical and
known.

Two of the projects EAgent studies — `oh-my-opencode-slim`
(`src/hooks/json-error-recovery/hook.ts`, `src/hooks/delegate-task-retry/`) and
`oh-my-openagent` (`packages/omo-opencode/src/hooks/edit-error-recovery/`) —
independently converged on the same cheap, deterministic mechanism: after a tool
runs, match its output against known failure signatures and **append a terse
corrective instruction** to the result so the model self-corrects on the next
turn instead of looping. It is a pure post-processing nudge — no model call, no
blocking, no state.

EAgent has the exact primitive this needs already: the `afterToolCall` filter
hook (`src/kernel/events.ts:59`), which transforms a tool result before it is
appended to the transcript (`src/kernel/agent.ts:303`). This task digests the
idea **as an extension**: a `recovery` extension that rides `afterToolCall`,
matches a small ruleset against *failed* tool results, and appends one
corrective hint keyed to EAgent's own error strings.

If we do not do this, EAgent keeps paying the retry-loop tax on its most common
self-inflicted tool errors, and the lesson both source repos teach — that a
deterministic error→hint table is among the highest-leverage reliability wins an
agent loop can have — goes unlearned.

## 2. Deliverables

- [x] `src/extensions/recovery.ts` — the extension: an `afterToolCall` guard
      that appends one corrective hint to a *failed* tool result, an exported
      default ruleset, an exported pure matcher, and an `EAGENT_RECOVERY=off`
      kill switch. (Also exports `annotate`, the guard transform, as the
      idempotency test seam — same behavior, exposed for unit testing.)
- [x] An exported pure helper `recoveryHint(content: string): string | null`
      returning the hint of the first matching rule (or `null`), and an exported
      `RECOVERY_RULES` constant — both unit-testable without the agent loop.
- [x] `test/recovery.test.ts` — offline tests covering the pure matcher
      (each default rule, no-match, first-match-wins), idempotency, and the live
      guard through the agent loop (a failed `edit` result the model sees carries
      the hint; a successful result does not; the kill switch suppresses it).
- [x] `recovery` registered in `BUILTIN_EXTENSIONS` (`src/host.ts`).
- [x] `CLAUDE.md` extension inventory updated with a one-line `recovery` entry.

`docs/EXTENSIONS.md` is **not** touched: per the `bash-policy` design
(`docs/design/2026-06-20-bash-policy.md:62`) it is the extension *author's
guide*, not a per-extension catalog, so there is nothing for a new extension to
slot into.

## 3. Scope Boundary (NOT in scope)

- **No kernel change.** `recovery` is purely additive on the existing
  `afterToolCall` hook; no kernel signature, event, or filter is touched.
- **Failed results only.** The guard annotates a result *only when*
  `result.isError === true`. Successful tool output is never scanned. This is a
  deliberate narrowing of the source repos, which scan *all* output and then
  maintain a per-tool exclusion list (so `read`/`grep`/`bash` whose legitimate
  output contains words like "error" are not falsely annotated). Scoping to
  error results removes that whole class of false positive and the exclusion
  list with it. Consequence (a failure reported with `isError` unset is not
  annotated) is documented in Risks.
- **At most one hint per result.** The first matching rule wins; rules are not
  stacked. Keeps the appended text short and avoids contradictory advice.
- **No blocking, no argument rewriting.** `afterToolCall` only transforms the
  *result*; `recovery` only ever *appends text*. It never blocks a call, never
  changes a tool's arguments, never alters a successful result.
- **No model call.** Unlike the secondary-model digestion patterns in the source
  repos, `recovery` does zero LLM work — it is a synchronous string match.
- **No user-configurable ruleset in this task.** The ruleset ships as a fixed,
  exported constant. A `e.store`-backed override or `/recovery` command is a
  future, separately-scoped change, explicitly out of scope here (Simplicity
  First). The `EAGENT_RECOVERY=off` env kill switch is the only runtime control.
- **No policy-block nudges.** Intentional `"Tool call blocked: …"` results
  (from `flow-guard` / `bash-policy`) are *not* in the ruleset: a policy denial
  is a deliberate decision, not a model-fixable mistake.
- **No new capability.** Appending guidance text to an already-failed result is
  not a side effect; the extension declares and requires nothing.

## 4. Key Design Decisions

### D1. Delivery vehicle: extension on `afterToolCall`, not a kernel change

- **Problem:** Where does error→hint annotation live?
- **Options:**
  1. Teach the kernel agent loop to append hints itself (bake a ruleset into
     `agent.ts`).
  2. Ship a self-contained extension on the existing `afterToolCall` filter
     hook, which already transforms results before they hit the transcript.
- **Choice:** Option 2.
- **Rationale:** Option 1 puts a policy table (which errors deserve which hint)
  into the kernel, violating "the kernel ships with zero opinions about tools"
  and "everything is an extension" (CLAUDE.md). Option 2 reuses the precise
  primitive built for result transformation (`afterToolCall`, the same family
  `prune` uses for its context transform), keeps the kernel untouched, and is
  hot-reloadable. Rejected Option 1 because error-recovery guidance is policy,
  and policy lives in extensions by EAgent's thesis.

### D2. Trigger scope: error results only, not all tool output

- **Problem:** Which tool results get scanned for failure signatures?
- **Options:** (a) every tool result, with a per-tool exclusion list so
  `read`/`grep`/`bash` output that legitimately contains error-like words is not
  falsely annotated (the source-repo approach); (b) only results with
  `isError === true`.
- **Choice:** (b).
- **Rationale:** EAgent already carries a first-class `isError` flag on
  `ToolResult` (`src/kernel/types.ts:131`), set by every tool's `fail(...)` and
  by the kernel's own error returns (`agent.ts:311,328`). Gating on it is the
  precise signal the source repos lacked and had to approximate with regexes +
  exclusion lists. Option (b) is strictly simpler (no exclusion list to
  maintain, no false positives on successful output) and strictly safer (a
  successful `read` that happens to contain the text "Text not found" is never
  touched). The cost — a failure surfaced with `isError` unset is not annotated
  — is acceptable because EAgent's own tools and kernel consistently set
  `isError` on failure (verified across `core-tools.ts` and `agent.ts`).

### D3. The ruleset: keyed to EAgent's own error strings, not generic patterns

- **Problem:** What does a rule match, and what ships by default?
- **Options:** (a) port the source repos' generic patterns (JSON-parse errors,
  delegation errors) verbatim; (b) author a ruleset keyed to the exact error
  strings EAgent actually emits.
- **Choice:** (b). A rule is `{ match: RegExp; hint: string }`. The default
  `RECOVERY_RULES`, each anchored to a verified EAgent error string:
  1. `/Text not found in /` (edit, `core-tools.ts:181`) → re-read the file and
     copy the exact text to replace, including surrounding lines and indentation.
  2. `/appears \d+ times|matches multiple places/` (edit ambiguity,
     `core-tools.ts:159,174`) → add surrounding context to make `old` unique, or
     pass `replaceAll: true`.
  3. `/much larger than the text to replace/` (edit disproportionate,
     `core-tools.ts:178`) → re-read and provide the exact, minimal text.
  4. `/Invalid arguments for /` (kernel validation, `agent.ts:328,340`) → fix the
     arguments to match the schema (every required field, correct types).
  5. `/is outside the workspace root/` (confine, `core-tools.ts:35`) → use a path
     inside the workspace root.
  6. `/Unknown tool: /` (kernel dispatch, `agent.ts:311`) → call one of the
     registered tools; check the exact tool name.
- **Rationale:** EAgent does not have the source repos' JSON-tool-call surface,
  so their JSON-parse rules would never fire here — porting them verbatim is
  cargo-culting. Keying rules to EAgent's real failure outputs makes every rule
  reachable and high-value (each maps to a genuine, observed retry loop). The
  rules are ordered; the first match wins (D4). The list is a fixed, reviewable
  constant — no open-ended growth in this task.

### D4. Application: first-match-wins, idempotent, single appended block

- **Problem:** How is the hint applied to the result, and what stops it from
  stacking or double-appending?
- **Choice:** `recoveryHint(content)` returns the hint of the **first** rule
  whose `match` tests true, else `null`. The guard, on a result with
  `isError === true` whose content does **not** already contain the sentinel
  marker `"Recovery hint:"`, appends `"\n\nRecovery hint: " + hint`. Already
  containing the marker → pass through unchanged (idempotent).
- **Rationale:** First-match-wins keeps output to one focused instruction
  (Simplicity First) and makes ordering the only precedence rule to reason
  about. The sentinel-marker idempotency guard means a re-applied result (e.g. a
  hook that runs over already-annotated content, or a future reload) cannot
  double-append — the same defensive idiom `integrity` uses for its baseline and
  the source repos use for their markers. The marker `"Recovery hint:"` is a
  stable string the tests assert on.

### D5. Shipping posture: builtin, on by default, env kill switch

- **Problem:** On by default, or opt-in?
- **Options:** (a) opt-in/no-op default (the `bash-policy` posture); (b) on by
  default with an `EAGENT_RECOVERY=off` kill switch (the `prune` posture).
- **Choice:** (b).
- **Rationale:** Unlike `bash-policy` (which *blocks* commands, so a wrong rule
  is disruptive and must be opt-in), `recovery` only ever *appends guidance to an
  already-failed result*. It cannot break a working path, cannot block, cannot
  touch success output. Its value — fewer wasted retries — is only realized if it
  runs without ceremony, exactly like `prune` (on by default, `EAGENT_PRUNE=off`
  kill switch; CLAUDE.md). The blast radius of a bad hint is "the model reads one
  extra sentence on a call that already failed," so on-by-default is the
  proportionate posture. Rejected (a) because a no-op default would bury a
  zero-risk reliability win.

## 5. Dependencies and Assumptions

- **`afterToolCall` filter hook** (`src/kernel/events.ts:59`; applied at
  `src/kernel/agent.ts:303`) transforms a `ToolResult` before it is appended to
  the transcript and accepts a replacement `ToolResult`. Assumed stable; it is
  part of the documented `KernelFilters` contract.
- **`ToolResult.isError`** (`src/kernel/types.ts:131`) is set by every failing
  tool (`fail(...)` in `src/kernel/define.ts:47`) and by the kernel's own error
  returns (`agent.ts:311,328`). The guard relies on this flag, not on parsing.
- **`ExtensionAPI`** surface used: `e.hook("afterToolCall", …)` and an env read.
  No `e.store`, no capability, no command in this task.
- **Test harness** `makeHarness` (`test/helpers.ts`) + `MockProvider` responder
  scripting drive the live tests offline; no network, no API key. A failed
  `edit` is produced by scripting an `edit` call whose `old` text is absent from
  a temp file (real `core-tools` `edit`, real `isError`).
- **No new npm dependency** (jiti-only rule upheld).

## 6. Relationship with Existing Designs

- **`docs/design/2026-06-20-bash-policy.md`** — the closest precedent: a
  security/quality extension that rides a filter hook (`beforeToolCall`), ships
  with an env kill switch, and exports pure helpers for unit testing. `recovery`
  mirrors its structure on the *result* side (`afterToolCall`) and reuses its
  `docs/EXTENSIONS.md`-is-not-a-catalog ruling (section 2). No conflict: the two
  guard different hook points and never share state.
- **`docs/design/2026-06-20-prune.md`** (the on-by-default + `EAGENT_*=off`
  kill-switch posture) is the precedent for D5. `prune` transforms context on
  `transformContext`; `recovery` transforms a single result on `afterToolCall`.
  Orthogonal hook points, no interaction.
- **`docs/design/2026-06-20-resilient-edit.md`** (the `edit-match` fuzzy ladder)
  is *complementary*: `edit-match` reduces how often `edit` fails by relaxing
  whitespace; `recovery` helps the model when it fails anyway. Rule 1/2/3 above
  fire only on the residual failures `edit-match` could not rescue (genuine
  not-found / ambiguous / disproportionate), so the two do not overlap or
  contradict — `recovery`'s "re-read the file" advice is exactly right for a
  span `edit-match` refused to guess.
- No terminology conflict. Anchors: CLAUDE.md ("everything is an extension",
  "capabilities are the security vocabulary"), and the existing extensions cited.

## 7. Acceptance Criteria

All criteria are verified by `npm test` (offline) and `npm run typecheck`. Live
criteria load **only** `core-tools` + `recovery` into the harness, so any
annotation is unambiguously `recovery`'s.

1. **Typecheck clean:** `npm run typecheck` exits 0 with the new files.
2. **Matcher — each rule (unit):** `recoveryHint` returns a non-null hint
   containing a rule-distinctive keyword for one representative trigger string
   per default rule, asserted by `assert.match`:
   - `"Text not found in /tmp/x.ts."` → hint mentions `re-read`.
   - `"Text appears 3 times in /tmp/x.ts; …"` → hint mentions `replaceAll`.
   - `"Text matches multiple places after whitespace-insensitive search in …"`
     (rule 2's *second* alternation branch, emitted by the resilient-edit
     ambiguous path, `core-tools.ts:174`) → same hint, mentions `replaceAll`.
   - `"The matched span is much larger than the text to replace in …"` → hint
     mentions `exact`.
   - `"Invalid arguments for edit:\n- …"` → hint mentions `schema`.
   - `'path "../etc" is outside the workspace root (…)'` → hint mentions
     `workspace`.
   - `"Unknown tool: frobnicate"` → hint mentions `tool name`.
3. **Matcher — no match (unit):** `recoveryHint("Wrote 12 bytes to /tmp/x.ts")`
   returns `null`.
4. **Matcher — first-match-wins (unit):** a *synthetic* string constructed to
   match two rules' patterns at once (the six default patterns are mutually
   exclusive on real EAgent error strings, so the test deliberately crafts an
   overlapping string rather than hunting a natural double-match) yields the
   *earlier* rule's hint (assert exact equality to that rule's hint).
5. **Idempotency (unit/live):** annotating a result whose content already
   contains `"Recovery hint:"` leaves the content unchanged (no second block).
6. **Live — failed edit is annotated:** with `core-tools` + `recovery` loaded
   and a real temp file, a scripted `edit` call whose `old` is absent produces a
   `tool_result` (the message the model sees on the next turn) whose content
   matches `/Recovery hint: /` **and** contains the rule-1 keyword `re-read`.
7. **Live — success is untouched:** a scripted successful `read` of the temp file
   produces a `tool_result` whose content does **not** match `/Recovery hint:/`.
8. **Kill switch:** with `EAGENT_RECOVERY=off`, the same failed `edit` as
   criterion 6 produces a `tool_result` that does **not** match `/Recovery hint:/`.
9. **Clean teardown:** disposing the extension removes the `afterToolCall` hook —
   after teardown, a subsequent failed `edit` result is **not** annotated
   (asserts the hook is unregistered, no leak).

No latency/throughput budget is declared: the guard runs a bounded sequence of
`RegExp.test` calls (six small patterns) per *failed* tool result only — off any
hot loop, microseconds — so a performance budget is intentionally excluded per
the section-3 Scope Boundary.

## 8. Risks and Rollback

- **R1 — A failure reported without `isError` is not annotated.** By D2, only
  `isError === true` results are scanned. *Mitigation:* EAgent's tools and kernel
  consistently set `isError` on failure (verified in `core-tools.ts`,
  `agent.ts`); a tool that reports failure in plain text without the flag is a
  bug in *that* tool, and is correctly out of `recovery`'s remit. No silent
  wrong behavior results — the worst case is "no hint added," identical to
  today.
- **R2 — A hint could mislead on an unusual error.** A rule's regex could match
  an error whose real cause differs from the common one. *Mitigation:* the hint
  is advisory text appended to a call that *already failed*; it cannot change a
  working path or block anything. Patterns are anchored to distinctive EAgent
  strings to minimize spurious matches, and `EAGENT_RECOVERY=off` is an instant
  escape hatch. One known imprecision is accepted under this risk: rule 4's
  `/Invalid arguments for /` also matches the `"… (after guards)"` variant
  (`agent.ts:340`), where the bad arguments were produced by a `beforeToolCall`
  guard rather than the model, so the hint advises the model about arguments it
  did not author. The blast radius is a single unhelpful sentence on an
  already-failed call, so the regex is left broad rather than narrowed to
  `/Invalid arguments for \w+:/`.
- **R3 — Over-annotation noise.** *Mitigation:* one hint per result (D4,
  first-match-wins) and the idempotency marker bound the appended text to a
  single short block.
- **Rollback:** remove the one line from `BUILTIN_EXTENSIONS` and revert the
  CLAUDE.md entry; the extension file is inert when not loaded and holds no
  persisted state. Setting `EAGENT_RECOVERY=off` disables it without a code
  change.
