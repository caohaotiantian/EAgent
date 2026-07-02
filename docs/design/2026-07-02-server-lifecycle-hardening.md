# L1 Design — HTTP server request-lifecycle hardening (SRV-1/2/3/5/6)

Status: draft
Slug: `2026-07-02-server-lifecycle-hardening`
Wave: 2 of the 2026-07-02 audit-gaps program. Source gaps: `docs/DEFERRED-FOLLOWUPS.md` SRV-1, SRV-2,
SRV-3, SRV-5, SRV-6. (SRV-4 stream-input caps = Wave 3; it's a provider/transport concern, not the
server request lifecycle.) Branch: `chore/audit-gaps`.

## 1. Problem / context

`src/server.ts` (the `POST /run` HTTP host) has request-lifecycle robustness gaps that let a single
request's failure escalate to a whole-host crash or unbounded growth. Confirmed by a register-blind
audit:
- **SRV-1** `streamRun` registers `res.on("close", …)` (`server.ts:345`) but no `"error"` listener while
  writing continuously (`res.write`, `:303`); an ungraceful client abort (ECONNRESET/EPIPE) can emit
  `'error'` on the `ServerResponse`. With no listener **and no process-level backstop anywhere in
  `src/`** (only SIGINT/SIGTERM), that error terminates the single process, dropping every session.
- **SRV-2** the top-level handler's `.catch` (`server.ts:159-161`) calls `sendJson`→`res.writeHead(500)`
  (`:420`); but `streamRun` already committed headers with `res.writeHead(200)` (`:299`) *outside* its
  own try (`:361`). A throw in the setup window (e.g. `agent.restore`) reaches the `.catch` → `writeHead`
  throws `ERR_HTTP_HEADERS_SENT` → rejects an un-awaited promise → host crash.
- **SRV-3** `sessions` (`server.ts:148`) is written a full `structuredClone`d `AgentState` per turn
  (`:370`) and freed only via `DELETE` (`:210`); a client rotating session ids grows the heap to OOM.
- **SRV-5** `main().catch` (`server.ts:453`, `cli.ts:442`) exits without `host.dispose()`, so
  `session_shutdown` never fires → orphaned stdio-MCP children on a crash.
- **SRV-6** `shutdown` (`server.ts:447-448`) has no re-entrancy guard; a second signal re-runs it,
  re-emitting `session_shutdown` to live handlers during the first dispose's await window.

## 2. Deliverables

1. **SRV-1** two parts: (a) a **class-wide** `res.on("error", …)` registered once at the top of the
   `createServer` callback (where every response is born), so a socket reset (ECONNRESET/EPIPE) on **any**
   response — streaming *or* the ~13 single-write `sendJson` responses (health/401/404/409/413/400/500) —
   is caught, not thrown as an uncaught `OutgoingMessage` `'error'` (which `route(...).catch` can't catch —
   it only catches promise rejections, not EventEmitter errors); and (b) `streamRun` additionally listens
   `res.on("error", onClose)` (removed in the `finally`) so a mid-stream socket error also runs the clean
   turn teardown (stop agent, drain elicitations). No process-level global handler (D1).
2. **SRV-2** two parts: (a) `sendJson` no-ops safely when headers are already sent
   (`if (res.headersSent) return;`), so the 500 fallback can never throw `ERR_HTTP_HEADERS_SENT`; and
   (b) `streamRun` moves `agent.restore` (and the hook-sub setup) **inside its `try`**, so a setup-window
   throw writes a `{type:"error"}` line + hits the `finally`/`res.end` instead of a silent 200 with no
   terminal line.
3. **SRV-3** a bounded `sessions` map with LRU eviction, **cap on by default** at `EAGENT_MAX_SESSIONS`
   (see D2).
4. **SRV-5** the server + CLI dispose the host on an error exit (symmetric with their signal paths).
5. **SRV-6** an idempotent `shutdown` (a `shuttingDown` guard) — on both the server and, symmetrically,
   the CLI (whose per-signal `process.once` handlers lack cross-signal idempotency).

## 3. Scope boundary

**In:** `src/server.ts`; a minimal symmetric `src/cli.ts` change for SRV-5; their tests
(`test/server.test.ts`, and a CLI test only if one already covers the exit path). **Out:** SRV-4
(stream caps, Wave 3); the by-design auth/yolo posture (RW-server, unchanged); per-session capability
isolation (RW4-2, closed); any change to the agent loop, kernel, or the streaming wire format. No new
dependency. **Simplicity First:** targeted listeners + guards + one bounded map; no framework, no
generic middleware layer.

## 4. Design / approach

- **SRV-1**: (a) at the top of the `createServer` callback (`server.ts:151`), `res.on("error", () => {})`
  (a no-op is sufficient — the goal is only to keep an `OutgoingMessage` `'error'` from escalating to an
  uncaught exception; Node's default socket cleanup still runs). This covers every response including the
  non-streaming `sendJson` ones. (b) In `streamRun`, additionally `res.on("error", onClose)` (removed in
  the `finally` via `res.off`), so a mid-stream error also runs the turn teardown; `onClose` is
  idempotent (flag + self-guarding `drainElicitations` + `if (agent.running) agent.stop()`), so
  `"close"` + `"error"` + the class-wide no-op all firing is still one effective teardown. **No global
  process handler** (D1).
- **SRV-2**: (a) `sendJson` guards on `res.headersSent` — when true the stream owns the response, so just
  `return` (never re-`writeHead`). (b) Move `agent.restore(...)` and the `subs` hook registration inside
  `streamRun`'s `try` (currently `restore` is at `:350`, before the `try` at `:361`), so a setup throw is
  caught, writes `{type:"error"}`, and reaches the `finally`.
- **SRV-3**: LRU over Map insertion order. **`Map.set` on an existing key updates the value but does NOT
  move its position** — so the write is made authoritative: at `:370`, `sessions.delete(session);
  sessions.set(session, snapshot)` moves the touched session to newest; then `while (cap > 0 &&
  sessions.size > cap)` `delete` the oldest key (`sessions.keys().next().value`). Read-side needs no
  separate re-touch (the same-turn write re-touches it), avoiding the miss-inserts-`undefined` hazard
  (`:350` restores `sessions.get(session) ?? initial`, so a naive read-side delete+set on a
  new/sessionless run would insert `undefined`).
  **Cap parse (G1/G-new-1 — a bad value must never hang the evict loop nor silently disable the cap):**
  a small pure helper `maxSessions()` (unit-testable): `const raw = process.env.EAGENT_MAX_SESSIONS?.
  trim(); if (!raw) return 1000; const n = Number(raw); return Number.isInteger(n) && n >= 0 ? n :
  1000`. So: unset / **empty (`EAGENT_MAX_SESSIONS=`)** / whitespace / non-numeric / negative /
  non-integer ⇒ **1000**; a non-negative integer overrides; only an **explicit `0` ⇒ unbounded** (the
  `cap > 0` loop guard skips eviction). The empty-string guard is load-bearing: `loadEnvFile` sets a bare
  `EAGENT_MAX_SESSIONS=` line to `""` and `Number("") === 0`, so without the guard an unfilled `.env`
  placeholder would *disable* the cap — the unsafe direction, re-opening the exact OOM SRV-3 closes.
  This also closes the round-2 hazards: a negative cap otherwise never terminates (`size > -1` stays
  true; `delete(undefined)` is a no-op → infinite loop), and a non-numeric cap otherwise makes
  `size > NaN` always false ⇒ silently unbounded.
- **SRV-5**: wrap the `main()` body in `try { … } catch (err) { await <dispose>; throw err }` so a throw
  disposes the host before the process exits (server: `await http.close()`; CLI: `await host.dispose()`),
  since `host`/`http` live inside `main()` and the outer `.catch` can't see them. (Edge — a throw
  *inside* `createHttpServer` after the host is built but before it returns still has no external handle;
  the build is synchronous config after the fail-closed guard, so this is a narrow, accepted residual.)
- **SRV-6**: `let shuttingDown = false; const shutdown = async (s) => { if (shuttingDown) return;
  shuttingDown = true; … }` on the server; the CLI gets the same shared-flag guard so SIGINT-then-SIGTERM
  disposes once.

## 5. Key design decisions (surfaced)

**D1 — process-level backstop policy.** Options: (a) **targeted only** — `res.on("error")` +
`headersSent` guard + restore-inside-try, no global handler; (b) log-only `unhandledRejection` +
log-then-exit `uncaughtException` (defense-in-depth); (c) swallow-and-continue everything (masks bugs —
rejected: Node warns the process is in an undefined state after `uncaughtException`). **Chosen: (a)
targeted-only.** Rationale: the targeted fixes close **both** known crash paths — the fresh L1 review
confirmed SRV-1's `res.on("error")` closes the unlistened-`'error'` path (`server.ts:345`) and SRV-2's
`headersSent` guard + restore-inside-try close the `ERR_HTTP_HEADERS_SENT` un-awaited-rejection path
(`:159-161,299,420`). A global handler is then pure defense-in-depth whose `unhandledRejection`
log-and-continue half **is** the option-(c) swallow-and-continue behavior (keeps running in a possibly
inconsistent state, overriding Node's default `--unhandled-rejections=throw`), is hard to verify in the
offline harness, and changes process-wide semantics — net negative under Simplicity First. If a future
*unknown* crash class appears, a fatal-and-tested handler can be added then, scoped to that class. **No
global handler ships in this wave.**

**D2 — sessions eviction policy + cap.** Options: (a) FIFO by insertion; (b) **LRU** (touch on
write); (c) TTL sweep (needs a timer). **Chosen: (b) LRU**, cap `EAGENT_MAX_SESSIONS`, **cap ON by
default at 1000** — i.e. **unset ⇒ 1000** (SRV-3's OOM fix is on out of the box); a positive integer
overrides; the explicit value **`0` disables** the cap (the backward-compat escape for anyone relying on
today's unbounded map). Rationale: LRU keeps *active* conversations and evicts idle ones (FIFO would
evict a still-active old session); Map insertion order makes LRU a write-side delete+set + an
evict-oldest loop, no timer. Default 1000: a session is one transcript snapshot; 1000 bounds worst-case
heap while sitting far above any real concurrent-conversation count. This is the one magic-number and it
is env-configurable; invalid/negative/non-integer values fall back to 1000 (see §4 SRV-3 cap-parse).
(Corrects the round-1 contradiction: **unset is 1000, not unbounded**; only an explicit
`EAGENT_MAX_SESSIONS=0` is unbounded.) *Caveat (G2):* the LRU re-touch is write-side only, so a
`danglingUser` turn (aborted before any assistant output, which skips the `:370` write) uses its session
without refreshing its position — acceptable, as that turn produced no state worth preserving.

## 6. Acceptance criteria

- **SRV-1a** class-wide error listener: emitting `'error'` on a **non-streaming** `sendJson` response
  (e.g. destroy the socket during/after a `/health` or 404 response) does not throw an uncaught
  exception / crash the process. **SRV-1b** streaming: emitting `'error'` mid-`/run` tears the turn down
  (agent stopped, elicitations drained, no escape).
- **SRV-2a** `sendJson` after headers sent: a unit test calls `sendJson` on a response with
  `headersSent=true` and asserts no throw + no second `writeHead`.
- **SRV-2b** restore-inside-try: force a setup-window throw by replacing the server agent's `restore`
  with a throwing stub (`agent.restore = () => { throw … }`) before a `/run`; assert the client gets a
  `{type:"error"}` terminal line + closed stream (not a silent 200 with no terminal line).
- **SRV-3** sessions LRU cap: with `EAGENT_MAX_SESSIONS=2`, three distinct sessions leave the map at
  size 2 and evict the least-recently-used; a re-touched old session survives. **Cap-parse (G1/G-new-1):**
  `EAGENT_MAX_SESSIONS=-1`, `=abc`, and **`=` (empty)** all fall back to the 1000 default (a small test
  asserts the `maxSessions()` helper directly, since observing the 1000 default via eviction needs 1001
  sessions); only **`=0` ⇒ unbounded** (3+ sessions all retained).
- **SRV-6** shutdown idempotency: two `shutdown()` calls run the dispose body once.
- **SRV-5** an error-path exit calls `host.dispose()`/`http.close()` once (assert via a spy/observable);
  the CLI half is pinned where the harness reaches it, else recorded as a known verification gap (§8).
- `<TEST-CMD>` (`npm test`) exit 0, `npm run typecheck` 0, `npm run eval` 0, `src/kernel/` untouched, no
  new dependency. (There is no SRV-1b process-handler criterion — SRV-1b was dropped, see D1.)

## 7. Risks / non-goals

- **Risk:** LRU write-side delete+set per turn → negligible (Map ops O(1)); `cap=0` skips the eviction
  loop entirely. **Risk:** moving `restore` inside the try changes which errors reach the top-level
  `.catch` → intended (they now become in-stream error lines); the top-level `.catch` + `headersSent`
  guard remain as the outer backstop for a pre-`writeHead` throw (auth, body-parse). **Non-goals
  (explicit):** a global `uncaughtException`/`unhandledRejection` handler (D1 — masking-prone,
  un-offline-verifiable; add a fatal-and-tested one only when a real unknown crash class appears);
  multi-tenant isolation, auth posture, rate-limiting, TTL expiry — out of scope / separately tracked.
- **Known residuals (acknowledged, not fixed here):** (G3) the CLI's SRV-5/6 hardening covers the
  *non-interactive* signal path (`cli.ts:198-204`); the **interactive REPL** has only `rl.on("SIGINT")`
  (`:183-192`) and no SIGTERM handler, so a SIGTERM to an interactive session still skips `host.dispose()`
  — a separate, pre-existing gap noted for a future pass. (Minor) SRV-5's pre-`http`/pre-`host`-return
  orphan window is *real*, not hypothetical: `session_start` fires at `server.ts:128` where stdio-MCP
  children spawn, so a later `session_start` handler throwing after an earlier one spawned a child leaks
  it with no handle to dispose — accepted (narrow, and `createAgentHost` build failures are already rare
  + fatal-at-startup). (Minor, pre-existing) `process.on("SIGTERM", () => void shutdown(...))` discards
  the shutdown promise, so a `host.dispose()` throw during shutdown becomes an unhandled rejection on an
  already-exiting process; SRV-6's `shuttingDown` guard is idempotency-only and does not change this
  exiting-process edge.

## 8. Test plan

Extend `test/server.test.ts` (offline, drives the server over an ephemeral port + a MockProvider host):
the four behaviors above (error-teardown, headersSent no-op, LRU cap, idempotent shutdown, dispose-on-
error). Existing server tests must stay green (the streaming wire format + auth + single-flight are
unchanged). CLI SRV-5: assert dispose-on-error only if an existing CLI test harness reaches the exit
path; otherwise pin it via the server path and note the CLI change as a symmetric one-liner.

## Closure

Status: closed
Closing-commit: 6d3ef80 (Phase 1 — SRV-1/2), fde1517 (Phase 2 — SRV-3/5/6)
Closed-on: 2026-07-02
Deferred: SRV-4 (stream-input caps → Wave 3); a global `uncaughtException`/`unhandledRejection` handler
(D1 non-goal); the CLI interactive-REPL SIGTERM gap (G3) + the SRV-5 pre-`http` orphan window (§7
residuals). No multi-tenant isolation / auth-posture change.

**Shipped (SRV-1/2/3/5/6), all in `src/server.ts` + `src/cli.ts`, no kernel change, no new dependency.**
L1 (4 rounds) resolved 2 severe + a new class-wide crash-class finding (S1) + 2 parse hazards
(G1/G-new-1); L2 (3 rounds) resolved a compile error + a testability gap + 4 acceptance-precision
issues; L3 both phases closed clean-first-round; F whole-project review pass. Gates: 9 new SRV tests +
`npm test` 1181 pass / 0 fail / 1 skip, typecheck 0, eval 5/5, kernel untouched.
