# Light-Mode brief — checkpoint kill switch (FRESH-50)

**Slug:** `2026-07-01-checkpoint-kill-switch` · **Tier:** Light (1 src file + README + 1 test; additive
opt-out, no breaking change, no new contract beyond the established `EAGENT_<NAME>=off` convention, no
migration, single-option decision). Source: the 2026-06-30 production-readiness verification audit
(FRESH-50). Branch: `chore/finish-deferred-followups`.

## What / why

`checkpoint` is a **default-loaded** builtin (`host.ts:119`) whose `beforeToolCall` auto-snapshot hook
(`checkpoint.ts:118`) fires on **every** `fs:write`/`shell:exec`/`code:exec` tool call inside a git
repo, running several **synchronous** `execFileSync('git', …)` calls (`stash create`, `rev-parse`,
`update-ref`) that block the Node event loop. It has **no** `EAGENT_CHECKPOINT=off` kill switch, no
store flag, no off command — violating the house convention (CLAUDE.md "House conventions": an
extension that *intervenes by default* ships an `EAGENT_<NAME>=off` kill switch; sibling `time-travel`
ships `EAGENT_TIME_TRAVEL=off` at `time-travel.ts:59`). On the multi-session HTTP host (which loads
checkpoint by default) this synchronous git on every mutation stalls the shared event loop for all
sessions with **no opt-out**.

**Change:** add an `EAGENT_CHECKPOINT=off` env kill switch as an early no-op return at the top of
`activate(e)` (mirroring `time-travel.ts:59`: `if (process.env.EAGENT_CHECKPOINT === "off") return;`),
so the extension registers **no hook and no commands** when disabled. Update the extension docstring
(it currently documents no kill switch) and the README `checkpoint` row's kill-switch column (`—` →
`EAGENT_CHECKPOINT=off`). Add an offline test asserting the off switch suppresses the auto-snapshot.

## Explicit non-goals (Simplicity First)

- **Not changing the default.** checkpoint stays **on by default** (this adds an opt-*out*, not an
  opt-in); existing behavior is byte-identical unless `EAGENT_CHECKPOINT=off` is set. Making checkpoint
  opt-in/off-by-default (like time-travel) is a separate, more opinionated decision, out of scope.
- **Not adding a `/checkpoint on|off` command or a store `enabled` flag.** `/checkpoint [label]` already
  creates a snapshot, so `/checkpoint off` would be ambiguous (label vs subcommand). The env kill switch
  is the clean, unambiguous opt-out. (No runtime toggle; disable is process-env-scoped, like the kill.)
- **Not making the git calls asynchronous.** The synchronous `execFileSync` blocking is real but a
  separate, larger change (an async-git refactor); the kill switch gives the concerned operator a
  complete opt-out today. Async git is registered as a possible follow-up, not built here.
- **Not touching the snapshot/rollback logic, the ref namespace, the cap, or the commands' bodies.**

## >1-option decision surfaced

**How to disable** — (a) env-only kill switch `EAGENT_CHECKPOINT=off`, on-by-default preserved
(**chosen**); (b) env kill switch **plus** make it opt-in (off by default + `/checkpoint on`); (c) a
`/checkpoint on|off` runtime toggle + store flag. **Chosen (a)** because it is the minimal change that
fixes the convention violation (a missing kill switch on an intervene-by-default extension), preserves
backward-compatible default behavior, and avoids the `/checkpoint` command-name ambiguity that (c)
would introduce. (b) changes the default (a behavior change for every current user) and (c) overloads
an existing command — both exceed the stated problem (no opt-out). The chosen option matches the
`time-travel.ts:59` kill-switch precedent exactly.

## Measurable acceptance command

- `node --import tsx --test test/checkpoint.test.ts` exit 0 — including a NEW test asserting that with
  `EAGENT_CHECKPOINT=off`, dispatching an `fs:write`-capability tool records **no** checkpoint
  (`list()`/`/checkpoints` stays empty), and a companion test (switch unset/absent) still records
  exactly one auto-snapshot — reusing the existing temp-git-repo harness in that file.
- `npm test` exit 0 (full suite, no regression) · `npm run typecheck` exit 0 · `npm run eval` exit 0.
- `src/kernel/` untouched (kernel line ceiling unaffected). No new npm dependency.

## Closure

**Closed** 2026-07-01. `EAGENT_CHECKPOINT=off` early-returns at the top of `activate`
(`checkpoint.ts:59`), registering no hook and no commands — mirroring `time-travel.ts:59`; on-by-default
preserved (byte-identical when unset). Docstring + README `checkpoint` row updated; a new offline test
asserts the off switch suppresses both the commands and the auto-snapshot (env restored in `finally`).
Light-Mode fresh review **pass** (clean first round; Full-Mode gate re-run — all five clear). Gates:
`test/checkpoint.test.ts` 5 pass, `npm test` 1144 pass / 0 fail / 1 skip, typecheck 0, eval 5/5,
`src/kernel/` untouched, no new dependency. Deferred (out of scope): making the auto-snapshot git calls
asynchronous (the kill switch gives the concerned operator a full opt-out today).
