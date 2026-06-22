# bash-policy rule ergonomics (justification text + pattern alternatives)

Tier: **Full Mode** (security extension; **first** change to the `Rule` schema —
the prior two argv0/wrapper tasks and the compound-commands task each pinned "No
change to the `Rule` schema"; this task deliberately reverses that boundary; it
also changes the pattern-matching contract, an external surface users author, and
carries a >1-option syntax decision with a documented breaking change).

Learned from: openai/codex `codex-rs/execpolicy`. Two authoring ergonomics that
EAgent's `bash-policy` lacks: (1) a rule carries a human-readable *reason* that is
surfaced when the rule fires, so a block explains *why*, not just *that* it
matched; (2) a pattern can name *alternatives* (`git [add|commit] *`) instead of
forcing one rule per variant.

## 1. Background and Purpose

After the prior `bash-policy` tasks (argv0 normalization, wrapper unwrapping,
compound-command expansion), the *matching* surface is strong but the *authoring*
surface is thin in two ways:

- **A deny/ask gives no reason.** When `rm *` blocks, the model sees
  `bash-policy: blocked rm (policy deny)` — the *that*, never the *why*. The rule
  author knows why they wrote the rule ("destructive; use the trash script"), but
  that knowledge never reaches the agent or the log. codex execpolicy attaches a
  justification to each rule and prints it on a forbidden call. Without it, a
  blocked agent cannot self-correct toward the intended alternative and a human
  auditing the transcript cannot tell an intentional policy from a typo.
- **One pattern matches one literal shape.** To allow `git add` and `git commit`
  but nothing else under `git`, an author writes two rules. For a family of N
  subcommands that is N near-duplicate rules, each a place to drift. codex lets a
  pattern enumerate alternatives. EAgent's matcher has exactly one metacharacter
  (`*`), so `git [add|commit] *` today matches a *literal* bracket string and
  never fires.

Neither is a security gap — both are quality-of-authoring. If we do nothing, rule
authors keep writing reasonless, duplicated rules, and blocked agents keep
guessing at intent. The cost of doing it is a schema field and one extra
metacharacter group in the pattern compiler — both small, both additive to
matching behavior, one (the bracket) a contained breaking change to pattern
*syntax* (§3, Decision 2, §8).

## 2. Deliverables

- [ ] `Rule` gains an **optional** `justification?: string` field. Rules without it
      behave exactly as today (criterion 5 regression). The field is free-text; no
      schema validation beyond "string if present".
- [ ] `evaluateAny` returns the **matched rule** alongside its existing
      `{ action, matched }` as a new optional field `rule?: Rule`, so the caller can
      read the winning rule's `justification`. The field is `undefined` on the
      fallthrough (no-rule-matched) path. Existing destructuring
      (`const { action, matched } = evaluateAny(...)`) is unaffected (additive
      field). `evaluate` (the single-command wrapper returning only `.action`) is
      unchanged in signature and behavior.
- [ ] The `beforeToolCall` guard surfaces the matched rule's justification (when
      present and non-empty) at **all three** existing user/model-facing surfaces,
      with **site-appropriate placement** so each reads cleanly:
      - **deny block reason** and **ask-denied block reason** — neither ends in
        punctuation, so the justification is appended as a suffix `: <justification>`
        (e.g. `bash-policy: blocked rm (policy deny): destructive — use ./scripts/trash`).
        Every existing marker (`bash-policy: blocked`/`denied`, `(policy <action>)`)
        is preserved as a substring.
      - **ask confirm prompt** — the existing text ends in `?`
        (`bash-policy: allow rm?`), so a trailing suffix would read `rm?: …`; instead
        the justification is inserted **before** the `?` as a parenthetical:
        `bash-policy: allow rm (destructive)?`.
      When absent/empty, the text at every site is **byte-identical to today**.
      Surfacing on the two *ask* sites (not just the deny site the request names) is
      a deliberate, low-cost extension — Decision 3, justified there.
- [ ] `toRegExp` gains **bracket-pipe alternation**: a `[` … `]` group compiles to a
      non-capturing alternation `(?: … | … )`; the interior is split on (unescaped)
      `|`, and within each alternative `*` → `.*` and every other regex metacharacter
      is escaped, exactly as outside a group. So `git [add|commit] *` matches
      `git add x` and `git commit x` but not `git push x`. A `|` **outside** any
      bracket group remains a literal, unchanged from today.
- [ ] **A `\` escape for the alternation metacharacters.** `\[`, `\]`, `\|`, and
      `\\` compile to a literal `[`, `]`, `|`, and `\` respectively — so a rule that
      must match a literal bracket, pipe, or backslash can. A `\` before **any other
      character** (or at end of string) emits a literal backslash and the next
      character is processed normally — this preserves existing patterns that contain
      a literal backslash (e.g. a `find … \;` terminator still matches `\;`). `*` has
      **no** literal form (it is always the wildcard, unchanged from today); the
      escape set is exactly `[ ] | \`.
- [ ] **Unterminated / degenerate brackets are fail-safe literals.** A `[` with no
      following unescaped `]` compiles to a literal `[` (and the rest literal), so a
      malformed pattern can never throw at compile time or match unexpectedly wide.
      Nested `[` inside a group is a literal character within the alternative (groups
      are flat, not recursive).
- [ ] `/bash-policy` status print appends ` (<justification>)` to a rule line when
      that rule has a justification, so `status` shows the reason the author wrote.
      The pattern still prints verbatim (an alternation pattern like
      `git [add|commit] *` shows literally), and rules without justification print
      unchanged. (Deliberately in scope — see §3.)
- [ ] Offline unit tests for `toRegExp` alternation (match/no-match, `*`-inside-group,
      metachar-escaping-inside-group, literal-`|`-outside, unterminated-`[`,
      empty-group) and for `evaluateAny` returning the matched rule; integration
      tests through the agent loop asserting the justification text reaches the
      blocked tool result and that an alternation rule blocks one alternative.
- [ ] CLAUDE.md `bash-policy` one-line description updated to mention the two new
      authoring affordances **only if** the current wording is now inaccurate (it
      describes the gate, not the rule schema — likely no change needed; the
      reviewer confirms). Closure block appended at F.

## 3. Scope Boundary (NOT in scope)

- **No regex beyond the one new group form.** The pattern language stays "`*` is
  `.*`, `[a|b]` is `(?:a|b)`, everything else literal". No character classes
  (`[a-z]` is *not* a range — inside a group `a-z` is one literal alternative), no
  quantifiers, no anchors, no backreferences, no nested groups. This keeps the
  ReDoS surface and the mental model minimal (Decision 2).
- **No `justification` validation, i18n, or templating.** It is opaque free-text
  echoed verbatim. No interpolation of the matched command, no length cap, no
  markup. (A future task could template it; out of scope here.)
- **No change to matching *semantics* for justification.** Justification never
  affects which rule wins or the action taken — it is display-only. `evaluateAny`'s
  last-match-wins resolution (2026-06-20-bash-policy.md D4) is untouched.
- **No change to the remember-key / label.** The session-remember key and display
  label stay `extractCommand(matched)` (2026-06-20-bash-policy.md D5). Justification
  is appended to the reason text, not folded into the family key.
- **No new config field plumbing for justification beyond the `Rule` object.**
  Authors set it where they already set `pattern`/`action` (via `e.store`); no new
  `/bash-policy` subcommand to author rules (the command remains on/off/status, as
  today — rule *authoring* via the command was never in scope and is not added here).
- **The `/bash-policy` `status` *output* IS deliberately in scope to change** — it
  gains the justification suffix (Deliverables) so an author can audit the reason
  text. This is the one reversal of the prior designs' "No change to the
  `/bash-policy` command" boundary, mirroring how §6 reverses the `Rule`-schema
  boundary; the command's on/off/status *behavior* and arguments are otherwise
  unchanged.
- **No change** to `ARITY`, `WRAPPERS`, `segments`, `findExecCommands`,
  `expandCommands`, `normalizeProgram`, `extractCommand`, `unwrap`, the
  `EAGENT_BASH_POLICY` kill switch, or the `commandArgKey` mechanism.
- **Breaking change, contained, intended, and escapable (not a residual):** a
  pattern that previously relied on a *bare* literal `[` … `]` substring (e.g.
  matching a shell `[ -f x ]` test) will now interpret the brackets as an alternation
  group. This is the deliberate cost of the syntax (Decision 2); existing rule
  *authors* in this repo write none (the test suite and docs contain no
  bracket-bearing or `\\`-bearing pattern — verified at L2). A downstream host that
  *does* need a literal bracket now writes `\[` / `\]` (Decision 2 adds the escape —
  changed from the first draft after a user decision favoring a hatch over a clean
  break); the unescaped-`[` reinterpretation remains the breaking change. Documented
  in §8.

## 4. Key Design Decisions

### Decision 1 — Thread justification by returning the matched rule, not a bare string

**Problem:** The guard builds the reason text, but `evaluateAny` is what knows
which rule won. How does the winning rule's `justification` reach the reason?

- **Option A — `evaluateAny` returns `justification?: string`.** Minimal, but it
  leaks one display concern into the resolver and discards the rest of the rule. If
  a later task wants another per-rule attribute at the reason site, the signature
  changes again.
- **Option B — `evaluateAny` returns the matched `rule?: Rule` (chosen).** One
  additive optional field carrying the whole winning rule; the guard derives
  `rule?.justification`. Additive to the return object, so existing
  `const { action, matched } = …` destructuring is untouched; `undefined` on the
  fallthrough path. The resolver stays display-agnostic (it returns *what matched*,
  not *how to phrase it*). This is the smaller conceptual change despite returning
  more, and it matches how the guard already treats `matched` (the resolver hands
  back facts; the guard formats).
- **Option C — re-derive the rule in the guard by re-scanning rules.** Rejected:
  duplicates the last-match-wins scan, risks divergence from `evaluateAny`, and is
  strictly more code for the same result.

Chosen: **B.** `evaluate` (single-command, returns `.action` only) is unchanged.

### Decision 2 — Bracket-pipe alternation `[a|b]`, not braces, top-level pipe, or full regex

**Problem:** What syntax expresses "match one of these alternatives" in a pattern
language whose only metacharacter today is `*`?

- **Option A — bracket-pipe `[add|commit]` → `(?:add|commit)` (chosen).** The form
  the request names. Visually distinct from `*`; alternation is *contained* inside
  the brackets so a `|` elsewhere stays literal (no accidental top-level
  alternation); compiles to a non-capturing group; degenerate forms are
  fail-safe-literal (Deliverables). Cost: `[`, `]`, `|` were escaped literals before
  (2026-06-20-bash-policy.md D4 escapes the full metacharacter set), so a pattern
  with a bare literal `[ … ]` changes meaning — the contained breaking change
  (§3, §8), mitigated by the escape below.
- **Option B — brace `{add,commit}` (shell brace-expansion style).** Rejected: `{`
  `}` appear literally in real command lines that rules match (`find … -exec rm {} \;`,
  `${VAR}`), so a brace metacharacter collides with the very strings being matched
  far more often than `[ ]` does; the collision is worse, not better.
- **Option C — top-level pipe `add|commit`** (no brackets). Rejected: with no
  delimiter the alternation has no bounds — `git add|commit *` is ambiguous between
  `git (add|commit) *` and `(git add)|(commit *)`. Brackets give the author explicit
  bounds for free.
- **Option D — full regex / glob.** Rejected: re-opens the ReDoS surface and the
  "minimal metacharacter" philosophy that D4 deliberately closed
  (2026-06-20-bash-policy.md:175–181 — "`*` is the only metacharacter … no full
  glob/regex surface"). One bounded group form is the smallest extension that
  satisfies the ask.

**A `\` escape for the alternation metacharacters (added per user decision).** `\[`,
`\]`, `\|`, and `\\` denote the literal characters; a `\` before any other character
is a literal backslash (preserving existing `\;`-style patterns). The first draft
shipped *no* escape (a rule needing a literal bracket would span it with `*`),
reasoning that an escape adds a second metacharacter concept for a case that does not
arise in this repo. The user chose to add the escape now so no downstream host's
rule can silently break on the syntax change — a hatch over a clean break. The cost
is one escape-aware branch in the compiler; `*` deliberately gets **no** literal form
(it stays the always-on wildcard, exactly as today — there was no way to match a
literal `*` before this task and that is unchanged), keeping the escape set minimal
(`[ ] | \`).

### Decision 3 — Surface justification at all three reason sites, display-only

**Problem:** Where does the justification appear, and does it ever change control
flow?

- **Choice:** Surface it (when present and non-empty) at the three places the guard
  already emits user/model-facing text — deny block reason, ask confirm prompt,
  ask-denied block reason — with **site-appropriate placement**: a suffix
  `: <justification>` on the two reason strings (neither ends in punctuation), and a
  parenthetical inserted before the `?` on the ask confirm prompt
  (`bash-policy: allow rm (destructive)?`), so no site reads as `rm?: …`. It never
  affects `action`, the remember key, or which candidate is `matched`.
- **Scope note (added affordance):** the literal request is "shown in *block*
  reasons" — i.e. the deny site. Extending to the two *ask* sites goes slightly
  beyond that ask. It is justified because the marginal cost is one shared formatting
  helper applied at sites that already build text (near-zero added complexity), and
  an author who writes a justification expects it wherever the rule speaks to them —
  the `ask` prompt is precisely where a human needs the reason to decide. Surfacing
  on `ask` is therefore in scope by deliberate choice, recorded here rather than
  smuggled in.
- **Rationale:** Appending/inserting (rather than replacing) preserves every existing
  stable marker (`bash-policy: blocked`, `bash-policy: denied`, the `(policy <action>)`
  tag) so existing tests and any log-scrapers keep matching; the empty/absent case is
  byte-identical to today (criterion 5). Display-only keeps Decision 1's "resolver
  returns facts, guard formats" split clean and means justification can never
  introduce a security regression (it cannot flip a deny to allow).
- **Rejected:** a separate structured field on the `ToolDecision` (no consumer for
  it; the reason string is the established channel, mirroring `flow-guard`); and
  emitting justification only on `deny` (inconsistent — `ask` is equally a place the
  author's reason helps the human decide).

## 5. Dependencies and Assumptions

- **`Rule` is consumed only inside `bash-policy.ts`** (the type is exported but the
  store reads/writes plain objects). Adding an optional field is backward compatible
  with any persisted ruleset: old rules simply lack `justification`. Verified at L2
  by grepping for external `Rule` importers.
- **`evaluateAny` callers:** `evaluate` (internal wrapper) and the guard, both in
  this file; plus tests. The additive return field breaks no caller. Verified at L2.
- **Reason text is the model/human channel**, as established by D5 and `flow-guard`
  (2026-06-20-bash-policy.md:191–197). No new UI surface.
- **Test harness** `makeHarness` + `MockProvider` + the `sawBlock`/reason-scraping
  helpers (`test/bash-policy.test.ts:189–194`) drive live-guard assertions offline;
  the justification assertion reads the `tool_result` content for the suffix. No
  network, no `ANTHROPIC_API_KEY`.

## 6. Relationship with Existing Designs

- **2026-06-20-bash-policy.md D4** (lines 159–184) defines the matcher: `*` the only
  metacharacter, all other regex metacharacters escaped. This task **extends** D4
  with exactly one bounded group form (`[a|b]`); it does not loosen D4's "no full
  glob/regex" stance (Decision 2 Option D). Marked as an intentional extension, not
  a conflict.
- **2026-06-20-bash-policy.md D5** (lines 186–206) defines action semantics and the
  `bash-policy: ` reason convention. This task **augments** the reason text
  (append-only) and preserves every stable marker. Not a conflict.
- **2026-06-21-bash-policy-wrapper-unwrapping.md:85** and
  **2026-06-21-bash-policy-compound-commands.md:99** each state "No change to the
  `Rule` schema". ⚠️ This task is the **first to change the `Rule` schema**
  (adding optional `justification`). Those statements scoped *their* tasks, not a
  permanent contract; this task's §3 records the change explicitly and it is
  additive (optional field), so no prior deliverable is invalidated. Source of truth:
  this design supersedes that boundary going forward.
- No conflict with `flow-guard`, `integrity`, or the other security extensions —
  this change is confined to `bash-policy.ts` and its test.

## 7. Acceptance Criteria

Each is mechanically checkable offline.

1. `npm run typecheck` exits 0.
2. `npm test` exits 0 (full suite; pre-existing tests unmodified except additive).
3. **Justification on deny reaches the model.** A deny rule
   `{ pattern: "rm *", action: "deny", justification: "destructive" }` on `rm -rf x`
   produces a blocked tool result whose reason contains `destructive` (and still
   contains `bash-policy: blocked` and `(policy deny)`). Asserted through the agent
   loop.
4. **Justification on ask reaches the confirm prompt and the denied reason.** An ask
   rule with a justification: the `ui.confirm` prompt string contains the
   justification **and still ends in `?`** (the parenthetical-before-`?` placement —
   e.g. matches `/allow .*\(destructive\)\?$/`); on a "no" answer the block reason
   contains the justification too.
5. **Absent justification is byte-identical to today.** A deny rule without
   `justification` produces the exact reason string the current code produces
   (regression pin: equals `bash-policy: blocked rm (policy deny)` for `rm -rf x`).
6. **`evaluateAny` returns the matched rule.** For a matching rule, the return's
   `rule` is the **same object reference** (`===`) as the winning `Rule` in the input
   array (Decision 1 returns the actual object, so `===` is the exact pin). On
   fallthrough (no rule matches): `rule === undefined`, `action === fallthrough`, and
   `matched === commands[0]` (the current behavior at `bash-policy.ts` `evaluateAny`'s
   `commands[0] ?? ""` return — for a non-empty input, `commands[0]`).
7. **Alternation matches each alternative and nothing else.**
   `toRegExp("git [add|commit] *").test(...)` is `true` for `git add x` and
   `git commit x`, `false` for `git push x` and `git addcommit x`.
8. **`*` and metachar escaping work inside a group.** `toRegExp("[a*|b.c]")` matches
   `axxx` and `b.c`, and does **not** match `bxc` (the `.` is literal inside the
   group).
9. **`|` outside a group stays literal; degenerate brackets are literal.**
   `toRegExp("a|b").test("a|b")` is `true` and `.test("a")` is `false`;
   `toRegExp("a[b").test("a[b")` is `true` (unterminated `[` literal); these compile
   without throwing.
10. **Alternation blocks through the guard.** A deny rule `git [add|commit] *` blocks
    `git commit -m x` via the agent loop (`sawBlock` true) and does not block
    `git push` (`sawBlock` false).
11. **`/bash-policy` status prints the justification.** With a justified rule loaded,
    the `status` output contains the justification text; an unjustified rule's line
    is unchanged.
12. **The `\` escape yields literal metacharacters.** `toRegExp("\\[a\\|b\\]")` matches
    the literal string `[a|b]` and does not match `a` or `b` (the brackets and pipe
    are literal, not a group); `toRegExp("find * \\;").test("find x \\;")` is `true`
    (an existing `\;`-style pattern still matches its literal backslash); these
    compile without throwing.

Quality budget: this is an authoring-ergonomics change on the existing guard hot
path; the only added per-call work is at most one extra alternation group in a
pre-compiled `RegExp` and a string concat on the block path (already the slow
path). No latency budget is declared — the matcher cost is unchanged in order of
magnitude (still one `RegExp.test` per candidate) and there is no measurable hot
path beyond the existing `evaluateAny`. Excluded explicitly per §3.

## 8. Risks and Rollback

- **Risk: the bracket breaking change silently re-interprets an existing pattern.**
  Mitigation: L2 greps the repo (tests, docs, examples) for any pattern containing
  `[` or `\\` and confirms none exists; the change is documented in §3 and here; the
  degenerate/unterminated case is fail-safe-literal so a stray `[` cannot throw or
  match wide; and a downstream host needing a literal bracket/pipe/backslash now has
  the `\[` / `\]` / `\|` / `\\` escape (Decision 2) — a hatch, not a forced rewrite.
  Likelihood in-repo: zero (verified at L2). For downstream hosts: a release note
  line documenting both the reinterpretation and the escape; the blast radius is one
  extension's pattern language.
- **Risk: a malformed bracket group throws at `RegExp` construction**, taking down
  the guard. Mitigation: the compiler emits only well-formed `(?: … )` groups and
  treats any unterminated `[` as a literal, so it never produces invalid regex; a
  unit test (criterion 9) pins compile-without-throw. As defense in depth, the
  existing guard already returns the decision unchanged on the non-matching path.
- **Risk: justification text changes a stable reason marker and breaks a
  log-scraper.** Mitigation: justification is strictly **appended** after the
  existing text; every current marker (`bash-policy: blocked`, `denied`, `(policy
  <action>)`) is preserved; the absent case is byte-identical (criterion 5).
- **Risk: returning the rule object aliases internal state** (caller mutates a rule).
  Mitigation: the guard only reads `rule.justification`; no mutation. Rules come from
  `e.store` and are treated as read-only throughout, as today.
- **Rollback:** the change is two small additions to one file (schema field +
  return field + one `toRegExp` branch + reason concat). Revert the commit to
  restore the prior matcher and reason text exactly; persisted rules with a
  `justification` field are simply ignored by the reverted code (optional field), so
  rollback needs no data migration.

## Closure

Status: open.
