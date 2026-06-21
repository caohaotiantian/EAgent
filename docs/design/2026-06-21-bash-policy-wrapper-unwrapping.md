# bash-policy wrapper unwrapping

Tier: **Full Mode** (security extension; introduces a new verdict-combination
semantic; carries genuine >1-option decisions with security trade-offs).

Learned from: openai/codex `codex-rs/execpolicy` resolves a command to the
program actually being run before matching rules. EAgent's `bash-policy` matches
only the literal head of the command line, so any *wrapper* program that runs
another command as its argument defeats a rule on the inner program.

## 1. Background and Purpose

`bash-policy` reduces a shell command line to a command family and evaluates an
allow/deny/ask ruleset against the line. Both steps key off the head token. A
**wrapper** — `sudo`, `env`, `nice`, `timeout`, `nohup`, … — runs another command
as its argument, so the head is the wrapper, not the real program:

- `sudo rm -rf /` → family `sudo`; a `{ pattern: "rm *", action: "deny" }` rule
  never matches and the command runs.
- `env FOO=bar rm -rf build`, `nice -n 10 rm -rf build`, `timeout 5 rm -rf build`
  — same bypass.

This is the wrapper class explicitly deferred by the prior task
(`2026-06-21-bash-policy-argv0-normalization.md`, Closure: "Deferred: wrapper
stripping"). It is the natural and most security-relevant follow-on: a policy
gate that is bypassed by prefixing `sudo`/`env` gives false assurance. If we do
nothing, deny/ask rules remain trivially evadable.

## 2. Deliverables

- [ ] `unwrap(commandLine): string | null` — a pure exported helper that, when the
      command's program (basename) is a recognized wrapper, consumes the wrapper's
      own option/argument prefix and returns the remaining **inner** command line;
      recurses for stacked wrappers (`sudo env rm`); returns `null` when the head
      is not a recognized wrapper or no inner program can be located.
- [ ] A small curated `WRAPPERS` data table mapping each supported wrapper to the
      minimal prefix-grammar it needs (arg-taking flags, leading positional count,
      whether `VAR=value` assignments precede the command).
- [ ] `evaluateAny(commands, rules, fallthrough): { action, matched }` with a
      precisely pinned algorithm (so the `evaluate` re-implementation is equivalent
      by construction, not by luck): **iterate rules from last index to first; the
      first rule R for which `commands.some(c => toRegExp(R.pattern).test(c))` holds
      is the winner; `action = R.action` and `matched` = the last command in the
      given `commands` order that R's pattern matches.** If no rule matches,
      `action = fallthrough` and `matched = commands[0]`. The existing single-line
      `evaluate` is reimplemented as `evaluateAny([command], …).action`; with one
      command this is identical to today's high-index→low short-circuit, so its
      signature and behavior are unchanged.
- [ ] `beforeToolCall` guard updated: build the candidate list **in the order
      `[outer, inner]`** — the normalized original line, plus (when `unwrap`
      returns one) the normalized unwrapped inner line — and run one `evaluateAny`
      pass. Label the block/ask, and key the session-remember set, with
      `extractCommand(matched)`. Because `matched` is the *last* matching candidate
      in `[outer, inner]` order, a winning rule that matches the inner line (whether
      inner-only or both) labels with the inner family; an outer-only match labels
      with the outer family. This is the deterministic tie rule for the
      both-candidates-match case.
- [ ] Offline tests: unit tests for `unwrap` (each supported wrapper, stacked
      wrappers, path-qualified wrapper, arg-flag forms, non-wrapper → `null`) and
      `evaluateAny` (last-match-wins across candidates, `matched` identity);
      integration tests through the agent loop proving a `rm *` deny
      blocks the command under each common wrapper, and proving a `sudo *` rule is
      **not** regressed (still fires).
- [ ] Closure block appended to this doc at F.

## 3. Scope Boundary (NOT in scope)

- **`xargs`, `find -exec`, `watch`, `parallel`** and any wrapper whose inner
  command is a *template* with placeholders / trailing operands. Their semantics
  differ from a simple prefix and invite mis-parsing; excluded. These (especially
  `xargs rm` / `find … -exec rm`) remain an open bypass after this task and are the
  natural next increment — called out here so the residual gap is explicit, not
  silent.
- **Shell metacharacters** (`;`, `&&`, `||`, `|`, `$( )`, backticks, redirections).
  `bash-policy` already does not parse compound command lines; unchanged here.
- **Exhaustive per-wrapper flag grammars.** The table covers the common option
  forms (`-u root`, `-uroot`, `--user=root`, boolean flags, leading positionals).
  An exotic/unusual form may cause a *missed* inner match — never a false block —
  because evaluation is additive (§4 Decision 1) and unwrapping is best-effort
  (§4 Decision 4).
- **Quote / word-split fidelity** beyond whitespace tokenization; matches the
  existing `commandTokens` behavior. Windows paths.
- **Wrappers outside the curated table.** Unrecognized head → no unwrap (today's
  behavior). Growing the table is a future, additive change.
- No change to the `Rule` schema, the `ARITY` table, the `evaluate` /
  `extractCommand` signatures, the `/bash-policy` command, the `EAGENT_BASH_POLICY`
  kill switch, or `CLAUDE.md`.

## 4. Key Design Decisions

### Decision 1 — Additive matching under preserved last-match-wins

**Problem:** When we recognize `sudo rm`, how do we make rules on the inner program
(`rm`) fire without (a) regressing rules on the wrapper itself and (b) breaking the
existing **last-match-wins** precedence, by which a more-specific later rule may
deliberately re-permit something an earlier rule denied?

The existing `evaluate` is last-match-wins over a single line (`bash-policy.ts`
`evaluate`): the action of the *last* matching rule wins, so a later `allow` can
override an earlier `deny`. Any solution must preserve that authority.

- **Option A — replace the line:** evaluate only the inner `rm`. **Rejected:** it
  silently breaks any rule that targets the wrapper itself — `{ pattern: "sudo *",
  action: "deny" }` would no longer block `sudo rm` absent a `rm` rule. A security
  *regression* introduced by a security feature.
- **Option B — strictest-wins over two independent verdicts:** evaluate the
  original line and the inner line separately, combine as `deny > ask > allow`.
  **Rejected:** strictest-wins is mathematically incompatible with last-match-wins
  and produces a **false block**. Counterexample: with rules
  `[ {rm *: deny}, {sudo rm *: allow} ]` the author has deliberately re-permitted
  `sudo rm`; the outer line evaluates to `allow` (the later rule wins) but the
  inner line evaluates to `deny`, and `strictest(allow, deny) = deny` blocks a
  command the policy explicitly allowed.
- **Option C — union at the matching level, one last-match-wins pass (chosen):**
  a rule *applies* if its pattern matches the original line **or** the unwrapped
  inner line; the action of the **last** applying rule wins. This is additive
  (inner-program rules now fire through the wrapper) **and** preserves last-match-
  wins authority (a later `sudo rm *: allow` still wins over an earlier `rm *:
  deny`). Re-checking the counterexample: rule `rm *` applies (matches inner) with
  `deny`; rule `sudo rm *` applies later (matches outer) with `allow`; last wins →
  `allow`. Correct. The wrapper-only case (`[sudo *: deny]`, `sudo apt update`)
  still blocks (the rule matches the outer line). Empty ruleset → fallthrough
  unchanged.

Rationale: Option C adds catches without ever removing one and without overriding
the author's own precedence — it strictly dominates A (no wrapper regression) and B
(no false block). It reuses the existing precedence rule rather than inventing a
second, conflicting one. Cost: each rule's regex is tested against at most two
short lines instead of one — negligible.

### Decision 2 — Curated wrapper table with a minimal prefix grammar

**Problem:** Each wrapper has its own option grammar; some take a separate
argument (`sudo -u root`, `nice -n 10`) and some a leading positional
(`timeout 5 cmd`). Generic "skip every `-flag`" mis-identifies positional/flag
arguments as the program.

The existing `commandTokens` already strips `-flags` and leading `VAR=value`
*when extracting a family for labeling* (`bash-policy.ts` `commandTokens`), but
that does not locate where the **inner program begins**: a wrapper's arg-taking
flag (`sudo -u root`) or leading positional (`timeout 5 cmd`) leaves a non-flag,
non-assignment token (`root`, `5`) sitting where the program would be. So finding
the inner command needs more than flag-skipping.

- **Option A — generic flag-skip only.** **Rejected:** treats `root` in
  `sudo -u root rm` and `5` in `timeout 5 rm` as the program, missing the inner
  `rm` for exactly the most common privilege/timeout wrappers.
- **Option B — codex-style full argument-type classifier** (per-program arg specs
  with readable/writable/integer types). **Rejected:** that is the per-command
  authoring maintenance tax the kernel deliberately avoids (CLAUDE.md: minimal
  core, zero heavy machinery); far more than this problem needs.
- **Option C — small data table (chosen):** per wrapper, record only what the
  prefix consumer needs: the set of arg-taking flags, a leading-positional count,
  and whether `VAR=value` assignments are accepted. A single bounded loop consumes
  the prefix using this table. Compact (≈8 wrappers), no type system, covers the
  common option forms (`-u root`, `-uroot`, `--user=root`, boolean flags).

Curated set: `sudo`, `doas`, `env`, `nice`, `ionice`, `timeout`, `nohup`,
`setsid`. Chosen for prevalence in agent shell use and a clear, simple prefix
grammar. Deliberately excluded: `time` (a shell *keyword* with its own parsing,
not a plain external program — recognizing a literal `time` token would be a
heuristic of low security value) and template wrappers `xargs` / `find -exec`
(§3). A wrapper's role (transparency, via this table) is orthogonal to the `ARITY`
table's role (family extraction for labeling): `env` appears in both because a
rule on `env` as a family still matches the original line under Decision 1's union,
while `env rm` additionally exposes `rm`.

### Decision 3 — Recognize the wrapper by basename, compose with normalization

**Problem:** A wrapper may be invoked by path (`/usr/bin/sudo`), and the inner
program likewise (`sudo /bin/rm`).

Choice: `unwrap` recognizes a wrapper by the **basename** of the head token, so
`/usr/bin/sudo` is recognized. The inner line it returns is then passed through
the existing `normalizeProgram` before `evaluate`/`extractCommand`, so a
path-qualified inner program (`/bin/rm`) is also normalized. This composes the two
hardening steps cleanly and reuses Decision A from the prior task rather than
duplicating path logic. Rejected alternative: normalize everything up front — the
inner line can still surface a fresh pathed program after unwrapping, so a single
up-front pass is insufficient.

### Decision 4 — Best-effort: ambiguity yields `null`, not a guess

**Problem:** What if the consumer cannot confidently find the inner program (empty
remainder, or an unclassifiable token)?

Choice: return `null` and evaluate only the original line (today's behavior). A
guess that mis-identifies the program would at worst evaluate a nonsense inner
line whose family matches no rule (a missed catch). Combined with Decision 1
(original always evaluated), best-effort unwrapping never regresses an existing
catch, and for **well-formed** wrapper invocations never produces a false block;
it only adds catches when it is confident. This is what bounds the risk of the
hard grammar cases.

One bounded exception, fail-safe by direction: a wrapper with a leading positional
(`timeout`, `positionals: 1`) consumes its first bare operand as that positional.
A *malformed* invocation that omits the positional — e.g. `timeout build.sh deploy`
(no duration) — therefore mis-locates the inner program and could match an inner
rule on the wrong token. The blast radius is small and acceptable: such a command
is itself broken (`timeout` would fail to parse the missing duration), so it would
not run regardless; the error is over-blocking an already-failing command, which
fails toward caution for a security gate rather than toward a bypass. The boundary
is pinned by a unit test rather than papered over with a per-wrapper duration
heuristic (Simplicity First: no special-casing for a command that cannot
meaningfully run).

### Decision 5 — Label with the family of the candidate the winning rule matched

**Problem:** A block/ask must show a family and use it as the session-remember key.
With two candidate lines, which family?

- **Option A — always the literal outer head the user typed** (`sudo`). **Rejected:**
  when the decision is driven by an inner-program rule, showing `sudo` hides the
  program the policy is actually about and would remember the wrong key (approving
  `sudo` once would wave through every wrapped command).
- **Option B — show both families.** **Rejected:** more text for no decision value;
  the remember key still has to pick one, so it does not resolve the question.
- **Option C — the family of the candidate the winning rule matched (chosen):** use
  `extractCommand(matched)`, where `matched` is the last candidate in `[outer,
  inner]` order that the winning rule matches (§2 Deliverable 3). So a rule matching
  the inner line (inner-only *or* both candidates) labels with the inner family
  (`rm` for a `rm *` rule that fired through `sudo`), and an outer-only match labels
  with the outer family (`sudo` for a `sudo *` rule). The human sees and approves
  exactly the program the matched rule is about, the both-match tie is resolved
  deterministically toward the inner program, and the remember key is scoped to
  that program.

Consequence for the `ask` remember key: approving a wrapped `rm` once (rule
`rm *: ask`) stores the family `rm`, so a later bare `rm` is auto-approved too —
the approval is scoped to the real program, not to the `sudo` spelling. This is the
intended scoping and is pinned by acceptance criterion 9.

## 5. Dependencies and Assumptions

- Reuses `normalizeProgram`, `evaluate`, `extractCommand` from `bash-policy.ts`
  (no signature changes). Reuses the `VAR=value` assignment shape already encoded
  in `commandTokens`.
- Assumes whitespace tokenization is acceptable (no quote handling) — consistent
  with the existing extension.
- No new runtime dependencies (CLAUDE.md: zero deps except `jiti`). Pure Node /
  TypeScript. Tests run offline against the existing harness.

## 6. Relationship with Existing Designs

- `docs/design/2026-06-21-bash-policy-argv0-normalization.md` — this builds
  directly on it. That doc's Closure explicitly defers "wrapper stripping
  (`env`/`sudo`/`command`/`xargs`) as a separate task"; this is that task. §4
  Decision 3 reuses its `normalizeProgram` helper and its Option-A choice
  (normalization at the hook choke point). No conflict.
- No other prior design documents exist (`docs/design/` was created by the prior
  task). Terminology anchors: `CLAUDE.md` (bash-policy description) and the
  `bash-policy.ts` source.

## 7. Acceptance Criteria (measurable, automatable)

1. `npm run typecheck` exits 0.
2. `npm test` exits 0 with no pre-existing test removed or weakened.
3. Unit: `unwrap("sudo rm -rf build")` → `"rm -rf build"`;
   `unwrap("env FOO=bar rm -rf build")` → `"rm -rf build"`;
   `unwrap("nice -n 10 rm x")` → `"rm x"`;
   `unwrap("timeout 5 rm x")` → `"rm x"`;
   `unwrap("sudo -u root rm x")` → `"rm x"`;
   `unwrap("sudo env /bin/rm x")` → ends with `rm x` after `normalizeProgram`;
   `unwrap("/usr/bin/sudo rm x")` → `"rm x"`;
   `unwrap("rm -rf build")` → `null`; `unwrap("git commit")` → `null`;
   `unwrap("sudo")` → `null`; `unwrap("")` → `null`.
4. Unit: `evaluateAny` last-match-wins across candidates —
   `evaluateAny(["sudo rm -rf build", "rm -rf build"], [{rm *: deny}], allow)` →
   action `deny`, `matched` is the inner line;
   `evaluateAny(["sudo rm -rf build", "rm -rf build"], [{rm *: deny}, {sudo rm *:
   allow}], allow)` → action `allow` (the later rule, matching the outer line,
   wins). The single-line `evaluate` keeps its existing test expectations.
5. Integration (through the agent loop, one rule `{ pattern: "rm *", action:
   "deny" }`): the command is **blocked** and the model sees a `bash-policy:` block
   reason for each of `sudo rm -rf build`, `env rm -rf build`,
   `nice -n 10 rm -rf build`, `timeout 5 rm -rf build`, `/usr/bin/sudo rm -rf build`.
6. Integration (no-regression): with rule `{ pattern: "sudo *", action: "deny" }`
   and no `rm` rule, `sudo apt update` is still blocked (wrapper rule preserved).
7. Integration (last-match-wins override preserved / no false block): with rules
   `[ {rm *: deny}, {sudo rm *: allow} ]`, `sudo rm -rf build` is **allowed** (runs,
   no block). This is the case Decision 1 Option B would wrongly block.
8. Integration (no false block): default no-op (empty ruleset) still runs
   `sudo rm -rf build` without a block.
9. Integration (`ask` remember key scoped to the inner program): with rule
   `{ pattern: "rm *", action: "ask" }` and a `confirm` that counts calls and
   returns true, running `sudo rm -rf a` then bare `rm -rf b` prompts **once** —
   the approval of the wrapped form is keyed to family `rm` and covers the later
   bare `rm`.

Quality budget: this is a guard on the existing per-tool-call path; the added cost
is at most one extra `evaluate` (a short regex test over a single line) plus a
bounded prefix scan. No latency budget beyond "the offline suite runs in
comparable time"; explicitly excluded as not user-perceptible.

## 8. Risks and Rollback

- **Risk: mis-parsed wrapper prefix.** Mitigated by Decision 1 (original line
  always evaluated → no regression) and Decision 4 (ambiguous → `null`). Worst case
  for a well-formed invocation is a missed inner catch, equal to today's behavior.
  The one exception (a malformed leading-positional wrapper, Decision 4) over-blocks
  an already-broken command — fail-safe for a security gate — and is pinned by a
  test.
- **Risk: surprising interaction with last-match-wins.** Resolved by §4 Decision 1
  Option C: the union happens at the matching level under the *existing* precedence
  rule, so a later, more-specific `allow` still overrides an earlier inner `deny`.
  Acceptance criterion 7 pins this behavior so a regression to strictest-wins would
  fail the suite.
- **Risk: unbounded recursion on stacked wrappers.** Not possible: the inner line
  `unwrap` returns always has at least argv[0] (the wrapper token itself) removed,
  so it has strictly fewer tokens than its input. Recursion on a strictly shorter
  token list terminates on any finite command line, independent of how many flags a
  grammar consumes. No explicit cap (and thus no magic-number bound) is needed; a
  stacked-wrapper test (`sudo env … rm`) confirms termination and correctness.
- **Rollback:** revert the single commit (additive helper + guard wiring + tests).
  The `EAGENT_BASH_POLICY=off` kill switch also disables the whole guard,
  unwrapping included. No stored state or schema to migrate.

## Closure

Status: open.
