# Light-Mode brief — server snapshot-on-abort dangling-`[user]` guard (KR-1)

Status: closed
Closing-commit: (this commit)
Closed-on: 2026-07-01
Deferred: none (KR-1 resolved).

**Slug:** `2026-07-01-server-abort-snapshot-guard` · **Tier:** Light (2 files: `src/server.ts` +
`test/server.test.ts`; an additive guard on one `if`; no breaking change, no new contract, no migration;
one resolved >1-option decision). Source: `docs/DEFERRED-FOLLOWUPS.md` KR-1 (registered during the
kernel-robustness wave). Branch: `chore/finish-followups-2`.

## What / why

`server.ts`'s `streamRun` persists the session snapshot on the `reason:"stop"`/success path
(`server.ts:365`: `if (session) sessions.set(session, agent.snapshot())`). After FRESH-1 an aborted run
resolves `reason:"stop"` (it used to reject and skip the persist), which is correct — **but** a *first*
turn aborted before any assistant output leaves the transcript as a bare `[user]` (the abort lands at
the post-`streamTurn` check `agent.ts:252-255`, before the assistant message is appended `:256`).
Persisting that dangling `[user]` snapshot means the next `/run` for the session `restore()`s `[user]`
then appends the new input → **two consecutive `user` messages**, which some providers (Gemini
strictly) reject. This edge is **pre-existing** (an early between-call abort already resolved
`reason:"stop"` and persisted), widened by FRESH-1 to the mid-stream timing.

**Change:** in `streamRun`, skip persisting when the transcript ends on a bare `user` turn:
```
const msgs = agent.messages;
const danglingUser = msgs.length > 0 && msgs[msgs.length - 1]!.role === "user";
if (session && !danglingUser) sessions.set(session, agent.snapshot());
```
The session keeps its last valid (assistant/tool-terminated) state; the aborted turn is discarded — the
pre-FRESH-1 behavior for the response side, now applied to the persist side.

## Explicit non-goals (Simplicity First)

- **Not changing the `reason:"stop"` response** (FRESH-1 is correct — a cancel is a clean stop). Only
  the *persistence* of a dangling snapshot is guarded.
- **Not dropping the dangling user message from the snapshot** (option (b) below) — skip-persist is
  simpler and correct; no snapshot mutation.
- **Not touching the disconnect path, the elicitation drain, `agent.restore` at turn start, the
  `/health` count semantics, or the kernel.** No new dependency.

## Any >1-option decision surfaced

- **How to avoid the dangling-`[user]` persist** — (a) **skip-persist when the transcript ends on a
  `user` turn, keeping the session's last valid state** (chosen); (b) persist the snapshot minus the
  trailing user message (mutate the snapshot); (c) do nothing. **Chosen (a)**: it is the smallest,
  no-mutation fix; it exactly restores the pre-FRESH-1 "an aborted turn is discarded from the session"
  behavior; and `msgs[last].role === "user"` is a **safe** detector — a resumable session must never end
  on a user message (the next input would double it), so *any* trailing-`user` state is one that should
  not be resumed-and-appended. It cannot false-positive on a normal completion (which ends on an
  assistant text turn) or a tool-terminated turn (ends on a `tool` message). (b) adds snapshot-mutation
  complexity for no benefit; (c) leaves the defect.

## Measurable acceptance command

- `node --import tsx --test test/server.test.ts` exit 0 — a NEW test: drive `/run` with a `session`
  under a provider that emits a `text_delta` while a hook calls `agent.stop()` (a mid-first-turn abort;
  same code path a client disconnect hits), read the NDJSON to the `done` (asserts `reason:"stop"`),
  then assert `GET /health` reports **0** sessions (the dangling-`[user]` turn was NOT persisted).
  Without the guard the aborted turn persists ⇒ 1 session ⇒ the test fails (a real discriminator). The
  existing "a session id makes /run accumulate conversation history" test (`server.test.ts:120`, asserts
  1 session after a normal `/run`) is the regression control that a *normal* turn still persists.
- `npm test` exit 0 (full suite) · `npm run typecheck` exit 0 · `npm run eval` exit 0 · `src/kernel/`
  untouched · no new dependency.

## Closure

**Closed** 2026-07-01. `streamRun` skips `sessions.set(...)` when `agent.messages` ends on a `user`
turn (`server.ts:363-371`), so a first-turn-aborted (dangling `[user]`) transcript is not persisted;
the session keeps its last valid state. Light-Mode fresh review **pass** (clean first round; Light tier
confirmed; the reviewer enumerated that no legitimate resumable state ends on a `user` message, so the
heuristic cannot false-positive; the red→green discriminator was empirically verified by reverting the
guard). Gates: `test/server.test.ts` 18 pass, `npm test` **1152 pass / 0 fail / 1 skip**, typecheck 0,
eval 5/5, `src/kernel/` untouched, no new dependency.
