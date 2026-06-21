# Light-Mode brief: `write-guard` extension — no blind overwrite of an unread file

Slug: `2026-06-21-write-guard`
Tier: Light Mode (≤3 non-load-bearing files: `src/extensions/write-guard.ts`,
`test/write-guard.test.ts`, `src/host.ts`; plus a rule-neutral one-line CLAUDE.md
inventory append. No breaking change, no new external contract.)

## What / why

EAgent's `write` tool (`src/extensions/core-tools.ts:91`) overwrites a file's
entire contents with no check that the agent has *seen* the file first — a model
that guesses a path, or regenerates a file from memory, can silently clobber
work it never read. `edit` is safe (it reads-then-replaces); `write` is the
blind-overwrite primitive. The upstream `oh-my-openagent` project ships exactly
this guard (`write-existing-file-guard`): track which files were read this
session, and prompt before a `write` overwrites an *existing* file that was
never read.

`write-guard` rides the `beforeToolCall` filter hook (the same primitive
`flow-guard` and `bash-policy` use). It records the resolved path of every
successful `read` / `edit` / `write` (a file you wrote, you know), and when a
`write`-shaped call targets an **existing** file **not** in that set, it asks
the human via `e.agent.ui.confirm`; a "no" blocks the overwrite, a "yes" lets it
through (and the subsequent successful write records the path, so it never
re-prompts for that file). On by default, no new capability,
`EAGENT_WRITE_GUARD=off` kill switch.

## Explicit non-goals

- **No guard on creating a *new* file.** If the target does not exist there is
  nothing to clobber; the call passes through untouched. This keeps the common
  case (writing new files) prompt-free.
- **No guard on `edit`** or any read-then-write tool — `edit` already reads the
  file before mutating it. Only full-content overwrites are guarded.
- **No blocking without a prompt, and no "deny" mode.** The guard *asks*; it does
  not hard-deny. (A model that legitimately means to overwrite confirms once.)
- **No persistence of the read-set across sessions.** It is in-memory,
  session-scoped, cleared on `session_start` / `session_shutdown` (matching
  `todo` / `bash-policy`'s session-scoped state).
- **No content diffing or backup.** Recoverability is `checkpoint`'s job
  (`checkpoint` already auto-snapshots before an `fs:write` tool); `write-guard`
  is the *proactive* "did you look first" prompt, orthogonal to it.
- **No configurable ruleset / command** in this task (Simplicity First). The env
  kill switch is the only runtime control.

## >1-option decision surfaced

**How to identify a "write-shaped" (full-overwrite) call** — options:
(a) match the tool literally named `write`; (b) match any tool declaring the
`fs:write` capability whose arguments carry a string `path` and string `content`
but **no** `old` field (the full-overwrite signature, which `write` has and
`edit` lacks). **Pick: (b).** Capability-based matching is EAgent's idiom
(`bash-policy` D2) and is robust to a differently-named full-writer, while the
`content`-without-`old` shape cleanly excludes `edit` and read-then-write tools.
Rejected (a) as brittle literal-name matching that would miss a renamed writer
and is the anti-pattern `bash-policy` explicitly avoided.

**Posture: ask, on by default** — `flow-guard` sets the precedent (on by
default, asks before a guarded action). Because the guard fires *only* on the
first overwrite of an existing, unread file — not on new-file writes or
re-writes of seen files — its prompt rate is low, so on-by-default is
proportionate. Under a UI that auto-confirms (tests' `autoUI(true)`, or `--yolo`
grants) it never blocks; under the headless default UI (`confirm → false`) it
blocks an unread overwrite, which is the safe direction. This is not a breaking
change (no schema/CLI/storage/protocol change; it adds a confirmation, the same
shape `flow-guard` already adds).

## Measurable acceptance command

`npm test` exit 0 (incl. new `test/write-guard.test.ts`) **and**
`npm run typecheck` exit 0. The new test asserts, offline via `makeHarness` +
`MockProvider` against a real temp-file workspace (`EAGENT_WORKSPACE`):
1. **unread existing file → asked, "no" blocks**: with a pre-existing file the
   session never read and a UI whose `confirm` returns `false`, a scripted
   `write` to it is blocked (the file's bytes are unchanged) and the model's
   tool_result carries a `write-guard:` reason.
2. **unread existing file → "yes" passes**: same, with `confirm` returning
   `true` — the write lands and the file is overwritten.
3. **new file → never asked**: a `write` to a non-existent path passes without
   any `confirm` call and creates the file.
4. **read-first → never asked**: a `read` of the file, then a `write` to it in
   the same session, passes without a `confirm` call.
5. **write-then-write → asked once**: two `write`s to the same pre-existing
   unread file invoke `confirm` exactly once (the first write records the path).
6. **edit is not guarded**: an `edit` to a pre-existing unread file passes
   without a `confirm` call (the `old`-arg signature excludes it).
7. **kill switch**: with `EAGENT_WRITE_GUARD=off`, case 1's blocked write instead
   passes with no `confirm` call.
8. **clean teardown**: after unloading the extension, case 1's overwrite is no
   longer guarded (the hook + listeners are disposed).

## Closure note

Status: closed. Closing-commit: f4aba41. Closed-on: 2026-06-21.
Acceptance: `npm test` exit 0 (336/336 pass, incl. the 9 new `write-guard`
tests), `npm run typecheck` exit 0. Fresh-eyes Light-Mode review: pass (tier
confirmed Light; zero severe, zero general). Deferred: none.
