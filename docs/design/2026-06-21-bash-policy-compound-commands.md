# bash-policy compound-command expansion (segmentation + find -exec + xargs)

Tier: **Full Mode** (security extension; new evaluation surface — a shell-aware
segmenter and embedded-command extractor; carries >1-option decisions with
false-block trade-offs).

Learned from: openai/codex `codex-rs/execpolicy` evaluates the program(s) a line
will actually run. EAgent's `bash-policy` evaluates only the *head* of a command
line, so every command reachable through a shell control operator or an embedded
runner is invisible to the ruleset.

## 1. Background and Purpose

After the prior two tasks (`…argv0-normalization`, `…wrapper-unwrapping`),
`bash-policy` resolves path-qualified programs and sees through *prefix* wrappers
(`sudo rm`). It still evaluates a command line as a **single** command. So any
program reached through a shell operator or an embedded runner bypasses every
deny/ask rule:

- `git status && rm -rf build` → head `git`; a `rm *` deny never fires.
- `cat list | xargs rm -rf` → head `cat`; the `rm` that actually runs is invisible.
- `find . -name '*.log' -exec rm -f {} \;` → head `find`; the embedded `rm` runs
  unchecked.
- `: ; rm -rf build` / `true || rm -rf build` — same class.

These are the most direct remaining bypasses of a command-granular policy. If we
do nothing, a deny rule is defeated by one `&&`, `|`, `;`, or `-exec`.

## 2. Deliverables

- [ ] `segments(commandLine): string[]` — split a line into command segments on the
      shell control operators `|`, `||`, `&&`, `;`, and newline, **only when they
      occur outside single/double quotes, outside `$( … )` / `( … )` / backtick
      groups, and not backslash-escaped**. Trims and drops empty segments.
- [ ] `findExecCommands(segment): string[]` — when a segment's program (by
      basename) is `find`, extract each embedded command introduced by `-exec` /
      `-execdir` / `-ok` / `-okdir`. The command is the tokens from just after the
      primary up to **but excluding** the terminator token; placeholders like `{}`
      are kept as operands (e.g. `rm -f {}`). A terminator token is one of `;`,
      `\;`, `+`, `';'`, `";"`, matched as a **whole token** (not a substring — so a
      `g++` operand is never mistaken for a `+` terminator). This detector is
      **separate** from `segments` — it does its own terminator recognition over the
      segment's tokens, since a quoted `;` is a find terminator yet not a shell
      split. `+` is recognized as a terminator token wherever it appears
      (best-effort; positional `{} +` adjacency is not required). If a clause has no
      terminator, the command runs to
      the end of the segment. Scanning continues past each terminator for further
      clauses.
- [ ] `xargs` added to the `WRAPPERS` table (its option grammar) so a `xargs …`
      segment unwraps to its inner command via the existing `unwrap`.
- [ ] `expandCommands(commandLine): string[]` — the unifying expansion: the
      normalized whole line first (preserving whole-line rules), then for each
      segment its normalized form, its `unwrap` inner (if any), and each
      `findExecCommands` result (also normalized + unwrapped). **Deduplicated by
      keeping the first occurrence and dropping any later candidate equal to an
      earlier one, order otherwise preserved.** (This first-wins, order-preserving
      rule is what makes `expandCommands("sudo rm -rf build")` collapse to exactly
      `["sudo rm -rf build","rm -rf build"]` — parity with the prior task — while
      keeping the inner/sub-command candidates *last* so Decision 5's
      last-match labeling still names the sub-command.)
- [ ] `beforeToolCall` guard updated to evaluate `evaluateAny(expandCommands(command),
      rules, fallthrough)`, replacing the current two-candidate `[outer, inner]`
      construction (which `expandCommands` subsumes). Labeling/remember key stays
      `extractCommand(matched)`.
- [ ] Offline tests for each helper and integration tests through the agent loop
      for the acceptance criteria below — including the **quoted-operator no-false-block**
      cases.
- [ ] Closure block appended at F.

## 3. Scope Boundary (NOT in scope)

- **Command substitution / process substitution interiors.** The segmenter tracks
  `$( )`, `( )`, and backtick *depth* so operators inside them do not spuriously
  split, but it does **not** descend into them to extract the inner program. So
  `echo $(rm -rf x)` is not caught — a *missed* catch equal to today's behavior,
  never a false block. Documented residual.
- **Redirections** (`>`, `2>&1`, `&>`, here-docs, here-strings). Not parsed; their
  tokens pass through as harmless operands. A lone `&` is **not** a split operator
  (only `&&` is), so `cmd &>file` is not mis-split. Note this also means a lone `&`
  used as a *sequencing* operator (`cmd & rm x` backgrounds `cmd` then runs `rm x`)
  is not segmented — an uncommon missed catch, fail-safe (under-block), accepted to
  avoid mis-splitting the far more common `&>` redirect and trailing-`&` background.
- **Quote stripping / word-split fidelity.** Consistent with existing `bash-policy`,
  quotes are not removed from tokens; a quoted program name containing spaces is
  not handled.
- **`$'…'` ANSI-C quoting, brace expansion, globbing, aliases, functions, eval.**
  Out of scope.
- **Here-docs / here-strings.** The scanner treats a here-doc body's newlines as
  ordinary newlines and may split it into spurious segments; this is the fail-safe
  over-block residual noted in §8, not a bypass (the whole line is always evaluated
  too). Not handled.

In scope and intended (pinned by criterion 3, not a residual): operators are
recognized **regardless of surrounding whitespace** — `a&&rm`, `a|rm`, `a;rm` are
split exactly like their spaced forms, since an attacker controls spacing and a
token-boundary splitter would be a trivial bypass.
- **xargs/find beyond the documented grammar.** Uncommon option forms may cause a
  missed inner match (best-effort, fail-safe), never a false block.
- No change to the `Rule` schema, the `ARITY` table, the `evaluate` /
  `extractCommand` / `normalizeProgram` / `unwrap` signatures, the `/bash-policy`
  command, the `EAGENT_BASH_POLICY` kill switch, or `CLAUDE.md`.

## 4. Key Design Decisions

### Decision 1 — Expand-then-additively-match, keeping the whole line

**Problem:** How to evaluate the multiple commands a compound line runs without
regressing rules written against the whole line or the wrapper head?

- **Option A — evaluate segments only** (drop the whole line). **Rejected:** a rule
  written against the literal whole line, or a wrapper-level rule, would stop
  matching — a regression of an existing catch.
- **Option B — additive expansion (chosen):** the candidate set is the normalized
  whole line **plus** every effective sub-command (segments, their unwraps, and
  `find -exec` commands), fed to the existing `evaluateAny` (one last-match-wins
  pass over all candidates). This strictly extends `…wrapper-unwrapping` Decision 1
  Option C: `expandCommands("sudo rm -rf build")` reduces to exactly the prior
  `[outer, inner]` set, so all prior behavior (override authority, no false block,
  no wrapper regression) is preserved, while new sub-commands only *add* catches.

### Decision 2 — A minimal quote/escape/group-aware segmenter, not naive split, not a full parser

**Problem:** Splitting on operators is unsafe if it splits operators that are
quoted or escaped — a legitimate `git commit -m "fix; bug"` or `find … {} \;`
would be torn into a spurious dangerous-looking segment and **false-blocked**.

- **Option A — naive `split(/[|;&]+/)`.** **Rejected:** false-blocks any well-formed
  command containing a quoted or escaped operator (commit messages, `echo "a|b"`,
  find's `\;`). This breaks the no-false-block property the prior task established.
- **Option B — a real shell parser / dependency.** **Rejected:** large, and EAgent
  is zero-dependency with a deliberately small core (CLAUDE.md). Disproportionate.
- **Option C — a single-pass scanner tracking `'`/`"` quote state, backslash
  escapes, and `$( )`/`( )`/backtick group depth (chosen):** split on `|`/`||`/`&&`/`;`/newline
  only at depth 0 outside quotes and unescaped. ~30 lines, no deps. Quoted/escaped
  operators stay intact (no false block); operators inside substitutions do not
  split (no false block). The cost is not descending into substitutions (a
  documented missed catch, §3), which is fail-safe.

  **Backslash/quote rule (pinned, matching bash, so the safe direction is not
  implementation-dependent):** a backslash escapes the next character when the
  scanner is unquoted **or** inside double quotes; inside single quotes a backslash
  is literal (it does not escape the closing `'`). This is the bash semantics:
  `echo "a\"b" && ls` keeps the escaped `\"` inside the double-quoted string (so the
  `&&` still splits cleanly — no false block), while `echo 'a\' && rm x` closes the
  single quote at the second `'` (so `rm x` is a real, separately-evaluated
  segment — no missed catch). Getting this backwards (honoring `\` inside single
  quotes, or not honoring `\"` inside double quotes) is the one place the scanner
  could false-block; the rule above and criterion 3's escaped-quote case pin it.

### Decision 3 — `find -exec` is an embedded-command extractor, not a prefix wrapper

**Problem:** `find`'s command is not a prefix; it sits mid-line between an `-exec`
family primary and a `;`/`+` terminator, and there may be several.

- **Option A — model `find` as a prefix wrapper in `WRAPPERS`.** **Rejected:** the
  command does not begin right after `find`'s options; the prefix-consumer model
  cannot express "between `-exec` and `;`", and would mis-locate the program.
- **Option B — a dedicated extractor (chosen):** gated on head basename `find`,
  scan for `-exec`/`-execdir`/`-ok`/`-okdir`, take tokens up to the terminator
  (`;`, `\;`, `+`, or a quoted form) as one command line, and continue for further
  clauses. Each result re-enters `normalizeProgram`+`unwrap` like any segment.

### Decision 4 — `xargs` via the existing `WRAPPERS` table

**Problem:** A `xargs …` segment should expose the command xargs runs.

- **Option A — bespoke xargs parser.** **Rejected:** duplicates the prefix-consumer
  already built for wrappers; xargs *is* a prefix wrapper (its command follows its
  options).
- **Option B — add `xargs` to `WRAPPERS` (chosen):** one table entry with xargs's
  *separated-value* flags (`-n -P -I -d -a -E -L -s` and long forms) listed in
  `argFlags`. `unwrap`'s existing consumer already handles both option spellings,
  and it is important the implementer not "simplify" this: a **separated** value
  (`-n 1`, `-I {}`) is consumed because the flag is in `argFlags` (skip flag + next
  token); an **attached** value (`-n1`, `-I{}`, `-d,`) is a single token that the
  consumer skips wholesale via its boolean-flag fallthrough (it is not in `argFlags`
  and carries no `=`), which lands on the program correctly. Both forms therefore
  resolve to the inner command; listing the separated forms in `argFlags` is the
  only addition needed. Reaching a *piped* `… | xargs rm` is what Decision 2's
  segmenter provides (the `xargs …` becomes a segment, then unwraps).

Note on labeling: `xargs` is added to `WRAPPERS` but deliberately **not** to
`ARITY` (§3). A rule written against `xargs` itself (`{ pattern: "xargs *" }`) still
matches the whole-line candidate and labels via `extractCommand`'s first-token
fallback as `xargs` — the same orthogonality the prior task noted for `env`
(in both `ARITY` and `WRAPPERS`).

### Decision 5 — Label with the matched sub-command family (reused)

The block/ask label and session-remember key remain `extractCommand(matched)`,
where `matched` is the last candidate in `expandCommands` order that the winning
rule matched (`…wrapper-unwrapping` Decision 5 / `evaluateAny`). The whole line is
candidate[0] (least-preferred), so when a sub-command rule fires, the human sees
the offending sub-command (`rm`), not the head (`git`/`find`/`xargs`). No new
decision; single consistent rule.

## 5. Dependencies and Assumptions

- Builds on `normalizeProgram`, `unwrap`, `WRAPPERS`, `evaluateAny`,
  `extractCommand` from `bash-policy.ts` (no signature changes; `expandCommands`
  replaces the guard's inline `[outer, inner]`).
- Zero new runtime dependencies; pure Node/TS; offline tests via `node:test`+`tsx`.
- Assumes whitespace tokenization within a segment (existing behavior); the
  segmenter adds quote/escape/group awareness only for *splitting*, not for token
  content.

## 6. Relationship with Existing Designs

- `docs/design/2026-06-21-bash-policy-wrapper-unwrapping.md` — strictly extends it.
  Decision 1 here generalizes its Decision 1 Option C (additive `evaluateAny`);
  `expandCommands("sudo rm …")` equals its `[outer, inner]`. §3 there deferred
  "`xargs` / `find -exec` template wrappers … the natural next increment"; this is
  that increment. No conflict.
- `docs/design/2026-06-21-bash-policy-argv0-normalization.md` — reuses
  `normalizeProgram` for each expanded candidate. No conflict.
- No supersession (both prior designs remain valid, independent layers).

## 7. Acceptance Criteria (measurable, automatable)

1. `npm run typecheck` exits 0.
2. `npm test` exits 0, no pre-existing test removed or weakened (the prior
   wrapper-unwrapping and argv0 suites stay green; `expandCommands("sudo rm -rf
   build")` yields the same effective candidates as before).
3. Unit `segments`: `segments("git status && rm -rf build")` → `["git status","rm -rf build"]`;
   `segments("a | b ; c")` → `["a","b","c"]`; `segments("true || rm x")` →
   `["true","rm x"]`; operators split **regardless of surrounding whitespace** (the
   scanner is character-level, and spacing is attacker-controlled) —
   `segments("git status&&rm -rf build")` → `["git status","rm -rf build"]`,
   `segments("a|rm x")` → `["a","rm x"]`; quoted/escaped operators are NOT split —
   `segments('git commit -m "a; b"')` → `['git commit -m "a; b"']`,
   `segments('echo "a | b"')` → `['echo "a | b"']`,
   an escaped `\"` inside double quotes does not mis-close the quote —
   `segments('echo "a\\"b" && ls')` → `['echo "a\\"b"', "ls"]`;
   `segments("find . -exec rm {} \\;")` → `["find . -exec rm {} \\;"]`;
   substitution interiors do not split — `segments("echo $(a && b)")` →
   `["echo $(a && b)"]`; a lone `&` does not split — `segments("sleep 1 &")` →
   `["sleep 1 &"]`.
4. Unit `findExecCommands`: `findExecCommands("find . -name '*.log' -exec rm -f {} \\;")`
   → `["rm -f {}"]`; two clauses
   `findExecCommands("find . -exec chmod 644 {} + -exec chown me {} \\;")` →
   `["chmod 644 {}","chown me {}"]`; non-find segment → `[]`.
5. Unit `unwrap` (xargs): `unwrap("xargs rm -rf")` → `"rm -rf"`;
   `unwrap("xargs -n1 rm")` → `"rm"` (attached value); `unwrap("xargs -n 1 rm")` →
   `"rm"` (separated value); `unwrap("xargs -I{} rm {}")` → `"rm {}"` (attached
   replstr); `unwrap("xargs -I {} rm {}")` → `"rm {}"` (separated replstr).
6. Unit `expandCommands`: `expandCommands("sudo rm -rf build")` equals
   `["sudo rm -rf build","rm -rf build"]` (parity with the prior task);
   `expandCommands("cat x | xargs rm -rf")` includes `"rm -rf"`;
   `expandCommands("find . -exec rm {} \\;")` includes `"rm {}"`.
7. Integration (rule `{ pattern: "rm *", action: "deny" }`, through the agent
   loop): each of `git status && rm -rf build`, `cat list | xargs rm -rf`,
   `find . -name '*.log' -exec rm -f {} \;`, `: ; rm -rf build` is **blocked** and
   the model sees a `bash-policy:` reason.
8. Integration (no false block on quoted operators): with `{ pattern: "rm *",
   action: "deny" }`, the command `git commit -m "fixup; rm temp"` **runs** (the
   `;` is quoted, no `rm` segment is produced).
9. Integration (no regression): the prior wrapper cases (`sudo rm …`,
   `nice -n 10 rm …`) still block; the override `[rm *: deny, sudo rm *: allow]`
   still **allows** `sudo rm -rf build`; empty ruleset still runs
   `git status && rm -rf build`.
10. Integration (`ask` remember keyed to the sub-command): rule `{ pattern: "rm *",
    action: "ask" }`, approve `a && rm -rf x` once, then a later bare `rm -rf y`
    prompts no second time (key is `rm`).

Quality budget: a guard on the per-tool-call path; added cost is a single-pass
scan plus `evaluateAny` over a bounded candidate list. No latency budget beyond
"the offline suite runs in comparable time"; excluded as not user-perceptible.

## 8. Risks and Rollback

- **Risk: spurious split inside an unhandled construct** (e.g. an operator inside a
  here-doc, or `$'…;…'` ANSI-C quoting the scanner treats naively). Could yield a
  spurious segment. Bounded: requires an exotic construct AND a matching deny rule;
  the whole-line candidate is always evaluated; the direction is over-block, not
  bypass. Documented residual (§3); mitigated by tracking quotes/escapes/`$()`/
  backticks which cover the common cases.
- **Risk: missed catch inside command substitution.** `echo $(rm …)` not caught —
  equal to today; documented (§3); fail-safe (no regression).
- **Risk: regression of prior behavior.** Prevented by Decision 1 (whole line
  retained; `expandCommands` parity with the prior `[outer, inner]`), pinned by
  acceptance criteria 2 and 9.
- **Risk: unbounded work.** Candidate count is bounded by the finite command
  length; `segments`/`findExecCommands` are single passes; `unwrap` terminates
  (prior task). No magic-number cap needed.
- **Rollback:** revert the single Phase commit (additive helpers + guard rewiring +
  tests). `EAGENT_BASH_POLICY=off` disables the whole guard. No stored state or
  schema change.

## Closure

Status: open.
