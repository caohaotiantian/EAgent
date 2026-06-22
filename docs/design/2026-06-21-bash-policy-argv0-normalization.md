# bash-policy argv[0] path normalization

Tier: **Light Mode** (2 non-load-bearing files, security-strengthening refinement,
no breaking change to any documented contract, no new external contract, no
unresolved >1-option decision, no magic numbers).

Learned from: openai/codex `codex-rs/execpolicy` — its policy engine resolves a
program invoked by absolute path back to its basename (the "host executable"
fallback) before matching rules, so a rule written for `git` also governs
`/usr/bin/git`. EAgent's `bash-policy` lacks this and is therefore bypassable.

## What / why

`bash-policy` matches its allow/deny/ask ruleset against a shell command line and
reduces it to a command family via an arity table. Both steps key off the literal
first token. So a `deny` rule for `rm` (e.g. `{ pattern: "rm *", action: "deny" }`)
is trivially bypassed by invoking the program through a path:

- `/bin/rm -rf /` → `prefix()` sees `/bin/rm` (absent from `ARITY`), family is
  `/bin/rm`, and `evaluate`'s regex `^rm .*$` never matches `/bin/rm ...`. The
  command runs despite the deny rule.

For a security extension this is a real policy-bypass hole. The fix is to
normalize the **program token only** — strip its directory so `/bin/rm`,
`./rm`, `../sbin/rm`, and `bin/rm` all reduce to `rm` — before evaluation and
family extraction. This makes path-qualified invocations subject to the same
rules as bare-name ones.

Implementation: a new exported pure helper `normalizeProgram(commandLine)` that
rewrites the first non-`VAR=value` token in place (preserving all other spacing
and tokens) to its basename when it contains `/`. The `beforeToolCall` guard
normalizes once and feeds the normalized line to both `evaluate` and
`extractCommand`.

## Explicit non-goals

- **Wrapper stripping** (`env rm`, `sudo rm`, `nice rm`, `xargs rm`, `time rm`,
  `command rm`). These are a distinct, larger problem with their own design
  questions (which wrappers, how deep, flags like `sudo -u`); explicitly out of
  scope here. Only direct path-qualified invocation of the program is closed.
- **Normalizing path-like arguments.** Only argv[0] (the program) is normalized;
  operands such as `cat /etc/passwd` or `rm /bin/foo` are untouched.
- **Quote / word-split correctness.** Tokenization stays whitespace-based,
  matching the existing `commandTokens` behavior; quoting is not handled here.
- **Windows backslash paths.** POSIX `/` only, matching the shell-command domain.
- No change to `evaluate`/`extractCommand` signatures, the rule schema, the
  `ARITY` table, commands, env kill switch, or `CLAUDE.md`.

## >1-option decision surfaced

**Where normalization lives.** Option A (chosen): a standalone exported helper
applied once at the hook choke point; `evaluate` and `extractCommand` stay pure
functions of their literal input. Option B: bake normalization inside
`extractCommand` and also normalize the `evaluate` input in the hook. Chose A:
single responsibility (the hook normalizes once), the pure helpers keep literal
semantics, and `normalizeProgram` is independently unit-testable. There is a
clear winner, so this stays Light Mode.

## Measurable acceptance command

```
npm run typecheck && npm test
```

Both exit 0. New tests assert: `normalizeProgram` strips a path program to its
basename (absolute, relative, dotted, env-prefixed) and leaves bare programs and
path-like arguments untouched; and an integration test that a `rm *` deny rule
blocks `/bin/rm -rf build` through the agent loop.

## Closure

Status: closed. `npm run typecheck && npm test` exit 0 (343 tests). Fresh-reviewer
diff review: PASS (zero severe, zero general). Deferred: wrapper stripping
(`env`/`sudo`/`command`/`xargs`) as a separate task.
