# L2 Implementation — HTTP server request-lifecycle hardening (SRV-1/2/3/5/6)

Status: draft
Slug: `2026-07-02-server-lifecycle-hardening` (matches the L1 design doc).
Design: `docs/design/2026-07-02-server-lifecycle-hardening.md`.
Files: `src/server.ts`, `src/cli.ts`, `test/server.test.ts`. No kernel change, no new dependency.
`<TEST-CMD>` = `npm test`; `<ACCEPT-CMD>` per phase below.

## Phase 1 — crash prevention (SRV-1, SRV-2)

**Scope:** close both request-lifecycle crash classes.
1. **SRV-1a** — in the `createServer((req, res) => …)` callback (`server.ts:151`), before `route(...)`,
   add `res.on("error", () => {})`. This suppresses an uncaught `OutgoingMessage` `'error'` (socket
   reset) on **every** response — streaming and the ~13 single-write `sendJson` ones.
2. **SRV-1b** — in `streamRun`, alongside `res.on("close", onClose)` (`:345`), add
   `res.on("error", onClose)`; in the `finally`, add `res.off("error", onClose)` next to the existing
   `res.off("close", onClose)`.
3. **SRV-2a** — `sendJson` (`:419`): first line `if (res.headersSent) return;` (before `writeHead`).
   **Export `sendJson`** (add to the module's exports, matching the file's existing export style) so the
   headers-sent branch is unit-testable — reaching it over real HTTP is impractical (SRV-2b now catches
   setup throws inside `streamRun`'s own `try`, so nothing routes a post-header throw to the top-level
   `.catch`→`sendJson(500)`).
4. **SRV-2b** — in `streamRun`, move `agent.restore(...)` (`:350`) and the `subs` hook registration
   **inside** the existing `try` (opens `:361`), so a setup-window throw is caught → writes
   `{type:"error"}` → hits the `finally`. Keep the `writeHead(200)` + `write`/`onClose`/elicitation setup
   before the try (they must run to stream). **Declare `subs` in the outer scope, typed:** `let subs:
   { dispose(): void }[] = [];` before the try (assigned inside), so the `finally`'s
   `for (const s of subs) s.dispose()` still sees it and TS infers no `any[]`.

**Acceptance (`<ACCEPT-CMD>`):** `node --import tsx --test test/server.test.ts` exit 0 with NEW tests:
- (a) **SRV-1b (deterministic no-crash)**: the primary behavioral proof that a response `'error'` does
  not crash the host. Open a raw `net.Socket`, write a valid `POST /run` request, read until streaming
  starts (the server is now writing continuously), then `socket.destroy()` → the server's next
  `res.write` reliably hits EPIPE → the response emits `'error'`. Assert the process survives (a
  follow-up `fetch('/health')` succeeds) and the turn tore down (single-flight `busy` released). The
  continuous-write stream makes the EPIPE deterministic (unlike a single small write).
- (b) **SRV-1a (class-wide, non-streaming)**: best-effort — same raw-socket destroy against a
  `GET /health`; assert no crash. **Acknowledged determinism caveat:** a single small response may buffer
  and emit no `'error'`, so this case is non-discriminating on its own; the deterministic no-crash
  guarantee comes from (a), and the class-wide `res.on("error")` registration (covering non-streaming
  responses) is additionally verified by inspection. Do not assert an outcome that can false-green.
- (c) **SRV-2a** (unit): call the exported `sendJson` with a `{ headersSent: true, writeHead: spy,
  end: spy }` stub res; assert no throw + `writeHead` not called.
- (d) **SRV-2b**: replace the server agent's `restore` with a throwing stub
  (`http.agent.restore = () => { throw new Error("boom") }`) before a `/run`; assert the client receives
  a `{type:"error"}` line then stream close (not a silent 200 with no terminal line).
- Plus `npm test` exit 0, `npm run typecheck` 0.

## Phase 2 — session cap + shutdown lifecycle (SRV-3, SRV-5, SRV-6)

**Scope:** bound the sessions map + symmetric dispose/idempotency.
1. **SRV-3** — add a module-level pure helper
   `function maxSessions(): number { const raw = process.env.EAGENT_MAX_SESSIONS?.trim(); if (!raw)
   return 1000; const n = Number(raw); return Number.isInteger(n) && n >= 0 ? n : 1000; }`. In
   `streamRun`, replace the write at `:370` (`if (session && !danglingUser) sessions.set(...)`) with:
   when writing, `sessions.delete(session); sessions.set(session, agent.snapshot());` then
   `const cap = maxSessions(); while (cap > 0 && sessions.size > cap) sessions.delete(sessions.keys().
   next().value as string);`. (Export `maxSessions` for the unit test, or test via a small internal
   export — match the file's existing export style.)
2. **SRV-5** — create the host **before** the wrapped body so the `catch` can see it (avoids the
   block-scope trap where `const http`/`host` live inside the `try`). Server `main()`:
   `const http = await createHttpServer(...); try { http.server.listen(...); …shutdown setup… } catch
   (err) { await http.close(); throw err; }`. CLI `main()`:
   `const { agent, host, … } = await createAgentHost(...); try { …rest of main… } catch (err) { await
   host.dispose(); throw err; }`. A throw *inside* `createHttpServer`/`createAgentHost` (before the
   handle exists) is the accepted pre-return-orphan residual (design §7). Keep the outer
   `main().catch(err => { console.error(err); process.exit(1); })` as-is. **Keep the CLI's normal-path
   `await host.dispose()` (`cli.ts:217`) OUTSIDE the guarded body** (after the `try`), so a throw from the
   success-path dispose can't re-enter the `catch` and double-dispose.
3. **SRV-6** — two complementary guards (design parity + a testable seam):
   (i) make `HttpServer.close` idempotent — in `createHttpServer`'s return object, `let closed = false;
   close: async () => { if (closed) return; closed = true; await built.host.dispose(); }` (the exported,
   harness-reachable seam); and (ii) also guard the server `shutdown` closure per design §4 — `let
   shuttingDown = false;` above it, first line `if (shuttingDown) return; shuttingDown = true;` — so a
   second signal doesn't re-enter `server.close()` / race `process.exit(0)` before the first dispose's
   await completes. (i) alone already prevents the double-`session_shutdown` (the `closed` flag is set
   synchronously before the await), but (ii) restores the design's stated shutdown idempotency. CLI: the
   same `let shuttingDown = false` flag guarding the signal-triggered `host.dispose()` path
   (`cli.ts:198-204`) so SIGINT-then-SIGTERM disposes once — a symmetric one-liner whose offline
   verification is a known gap (the CLI signal closures aren't in-process reachable), recorded per §8.

**Acceptance (`<ACCEPT-CMD>`):** `node --import tsx --test test/server.test.ts` exit 0 with NEW tests:
- (a) **SRV-3 parse**: the exported `maxSessions()` returns 1000 for unset / `""` / `"  "` / `"abc"` /
  `"-1"` / `"1.5"`, `N` for `"N"`, and `0` for `"0"` (each set via `process.env` + restored).
- (b) **SRV-3 LRU (identity, not just size)**: with `EAGENT_MAX_SESSIONS=2`, run sessions A, B, then a
  `/run` re-touching A, then C. Assert size stays 2 via `GET /health` (`:199`), AND probe *identity* with
  `DELETE /sessions/<id>` (returns 200 `existed` vs 404 `evicted`, `:208-212`): B (the LRU) is evicted →
  404; A (re-touched) survives → 200; C survives → 200. Size alone can't distinguish LRU from FIFO, so
  the DELETE probe is what pins "evict the *least-recently-used*."
- (c) **SRV-3 disabled**: with `EAGENT_MAX_SESSIONS=0`, three sessions all retained (`/health` shows 3;
  all three `DELETE` → 200).
- (d) **SRV-6 idempotency**: register a `session_shutdown` counter on `http.agent.hooks` (dispose emits
  it once, `extension.ts:204`); call `http.close()` twice; assert exactly one `session_shutdown`. (`close`
  is the exported, reachable seam; `built.host` is not on the `HttpServer` interface, so the emission
  count — not a `host.dispose` spy — is the observable. The signal `shutdown` closure isn't offline
  reachable but calls this idempotent `close`.)
- (e) **SRV-5** (documented verification gap, not a behavioral test): the offline harness can't reach
  `main()`/`main().catch`, so the dispose-on-error wrapper is verified by inspection (the `catch { await
  http.close(); throw }` shape) + the fact that `close` is idempotent; recorded as a known gap per design
  §8. (No false-green behavioral assertion.)
- Plus `npm test` exit 0, `npm run typecheck` 0, `npm run eval` 0, `src/kernel/` untouched, no new
  dependency.

## Sequencing / notes

- Phase 1 then Phase 2 (independent, but Phase 1 is the higher-value crash fix). Both touch `server.ts`;
  Phase 2 also touches `cli.ts`.
- Existing `test/server.test.ts` behaviors (streaming wire format, auth, single-flight `busy`, DELETE,
  `/health`) must stay green — the changes are additive listeners/guards + a bounded map, not wire
  changes.
- Trace test: every changed line maps to SRV-1/2/3/5/6 in the design's Deliverables. No drive-by edits.

## Closure

Status: closed
Closing-commit: 6d3ef80 (Phase 1), fde1517 (Phase 2)
Closed-on: 2026-07-02
Deferred: SRV-4 → Wave 3. See the design doc's closure for the full deferred/residual list.

Both phases closed clean-first-round in L3; F whole-project review pass. `maxSessions` + `sendJson`
exported for their unit tests; `HttpServer.close` made idempotent as the testable SRV-6 seam.
