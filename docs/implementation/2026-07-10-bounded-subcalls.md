# Implementation — Bounded/abortable provider sub-calls (Batch D)

Slug: `2026-07-10-bounded-subcalls` (matches the design doc)
Status: closed
Closing-commit: Batch D closeout on `chore/production-hardening`
Closed-on: 2026-07-10
Deferred: none (both phases closed on their first L3 review).
Result: 2 phases, both closed round 1. Suite 1302 → 1307 pass (+5: helper unit tests, compact + evals hang/fallback tests), 0 fail, 1 skip; typecheck 0; eval 5/5; build 0. All eight never-bounded provider sub-calls now run under a ref'd deadline (+ caller signal at the two tool sites) via `lib/sub-call.ts`.

## 1. Task Index

Design: `docs/design/2026-07-10-bounded-subcalls.md`. Deliverables D1–D11 → §2; Acceptance AC1–AC5 →
§7; KDD1–3 → §4.
- Phase 1 → D1, D10, D11(helper) — the lib helper + shared `Hanging` provider + helper unit tests
  (AC1, AC2).
- Phase 2 → D2–D9, D11(sites) — adopt at all 8 sites + representative site tests (AC3) + the AC4 gate.
- Both satisfy AC5 (gates).

## 2. Phase Breakdown

`<TEST-CMD>` = `npm test`. Every phase leaves it green and adds runnable `<ACCEPT-CMD>`. Tests before
implementation.

### Phase 1 — the `runSubCall` helper + shared `Hanging` test provider

- **Entry condition:** branch `chore/production-hardening`, suite green (baseline 1302 pass / 1 skip).
- **Design references:** §2 D1/D10/D11, §4 KDD1/KDD3, §7 AC1/AC2, §5 (reference patterns).
- **Task list (TDD order):**
  1. **T1.1 (test infra)** — export a reusable `Hanging` provider from `test/helpers.ts`: a
     `MockProvider` subclass whose `stream(req)` never yields and rejects (`new Error("provider
     hung")`) only when `req.signal` aborts (lift the template from `test/risk-guard.test.ts:368-378`;
     `risk-guard.test.ts` may keep its private copy or import the shared one — do not break it).
  2. **T1.2 (test)** — create `test/sub-call.test.ts`. Protected invariant: *a provider sub-call must
     terminate on a deadline (throwing a distinguishable timeout error) or on the caller's abort — it
     must never hang, and its timer must not leak.* Cases (RED — helper absent):
     - **AC1 timeout:** `await assert.rejects(runSubCall(new Hanging(...), req, { timeoutMs: 50 }),
       /timed out/)` (the synthesized timeout error, NOT the Hanging provider's own message).
     - **AC1 success:** `runSubCall(mockProvider, req, { timeoutMs: 5000 })` resolves to the `done`
       `Message` whose `textOf(...)` equals the mock's scripted text.
     - **AC2 caller abort:** with a caller `signal` that aborts at ~20 ms and `timeoutMs: 5000`,
       `runSubCall` rejects (caller-abort wins), and the thrown error does NOT match `/timed out/`.
     - **AC2 timer cleared:** spy `clearTimeout` (`t.mock.method(globalThis, "clearTimeout")`); assert
       it is called (≥1, or called-with-our-timer — NOT an exact global count, since node:test itself
       calls `clearTimeout` internally) on the success path, the timeout path, and the caller-abort
       path (a leaked ref'd timer would otherwise only delay process exit, which node:test does not
       fail on).
     `req` here is an `Omit<CompletionRequest, "signal">` (systemPrompt/messages/tools/model).
  3. **T1.3 (impl D1)** — create `src/extensions/lib/sub-call.ts`:
     `export const DEFAULT_SUB_CALL_TIMEOUT_MS = 30_000;` and
     `export async function runSubCall(provider: Provider, req: Omit<CompletionRequest, "signal">,
     opts: { timeoutMs: number; signal?: AbortSignal }): Promise<Message>`. Build one
     `AbortController`; a ref'd `setTimeout(() => { timedOut = true; controller.abort(); }, opts.timeoutMs)`;
     link the optional caller signal (`if (opts.signal) { if (aborted) controller.abort(); else
     addEventListener("abort", onAbort, {once:true}); }`); `for await` `provider.stream({ ...req,
     signal: controller.signal })` collecting the `done` message; in a `finally`, `clearTimeout(timer)`
     + `removeEventListener`. On the way out, `if (timedOut) throw new Error(\`sub-call timed out after
     ${opts.timeoutMs}ms\`)` — both after a clean loop and in a `catch` that rethrows the original
     error when `!timedOut`. Throw `"sub-call ended without a done event"` if no message and not
     timed out. Import `Provider`/`CompletionRequest`/`Message`/`StreamEvent` from `../../kernel/types.js`;
     no `ExtensionAPI`.
- **Per-task acceptance command:** `node --import tsx --test test/sub-call.test.ts` (exit 0).
- **Exit condition:** `test/sub-call.test.ts` green; `npm test` green (0 fail — `risk-guard.test.ts`
  still passes whether or not it adopts the shared `Hanging`); `npm run typecheck` 0.

### Phase 2 — adopt `runSubCall` at all eight sub-call sites

- **Entry condition:** Phase 1 merged; suite green.
- **Design references:** §2 D2–D9, §4 KDD1–3, §7 AC3/AC4, §8 R1.
- **Task list (TDD order):**
  1. **T2.1 (test)** — representative site tests. Protected invariant: *a hung provider must not hang a
     turn — the site falls back (fail-open) or fails-closed on the sub-call deadline.* Each with
     `{ timeout: 1000 }` so the pre-fix hang fails cleanly:
     - `test/compact.test.ts` (fresh-signal site): drive a turn that triggers compaction with a
       `Hanging` provider registered and `compact.subCallTimeoutMs = 50` (via the harness config);
       assert the run **completes** (RED before the fix = the per-test `{timeout:1000}` fires) and the
       compaction fell back — assert the AC-12 way (a summary/result is present, run < 1 s), NOT by
       importing `renderFallback` (it is a private, unexported function at `compact.ts:129`). Because a
       `Hanging` provider can never succeed, "completed + fallback present" proves the timeout path.
       Reuse the file's existing `overBudget()`/`applyHook` compaction-trigger setup.
     - `test/evals.test.ts` (`ctx.signal` site): invoke the `judge` tool with a `Hanging` provider and
       `evals.subCallTimeoutMs = 50`; assert it returns a `fail(...)` result (RED: hangs before fix).
  2. **T2.2 (impl D2–D9)** — replace each site's `for await (provider.stream({... signal: <fresh|ctx>
     }))` loop with `const msg = await runSubCall(provider, { systemPrompt, messages, tools: [], model
     }, { timeoutMs: e.config.int("<ext>.subCallTimeoutMs", DEFAULT_SUB_CALL_TIMEOUT_MS), signal });`
     then the site's existing `textOf(msg)`/parse. Per site:
     - Fresh-signal (no caller signal → omit `signal`): `compact.ts:187-197`, `routing.ts:243-253`,
       `drift-probe.ts:243-253`, `goal.ts:330-340`, `handoff.ts:456-467`, `session.ts:198-213`.
     - `ctx.signal` sites (pass `signal: ctx.signal`): `evals.ts:482-503`, `reasoning-search.ts:197-207`
       (thread the existing `signal` param into `runSubCall`).
     Leave each site's surrounding `try { … } catch { <fallback> }` unchanged — it now also catches the
     thrown timeout. **Preserve each site's existing request fields** — do NOT blind-paste
     `model: e.agent.model`: `routing.ts:240,248` uses `agent = currentActingAgent() ?? e.agent` and
     `model: agent.model`; keep each site's own systemPrompt/messages/model expressions, changing only
     the stream call → `runSubCall`. The six fresh-signal sites **omit** the `signal` option entirely;
     only `evals`/`reasoning-search` pass `signal`. Do NOT touch `risk-guard.ts` (the reference),
     `fallback-routing.ts`, `recovery.ts`, `microagents.ts`.
- **Per-task acceptance commands:**
  - `node --import tsx --test test/compact.test.ts test/evals.test.ts`
  - Positive gate: `grep -la 'lib/sub-call.js' src/extensions/{compact,routing,drift-probe,goal,handoff,session,evals,reasoning-search}.ts` lists all eight.
  - Negative gate (wired for the empty-match exit code — `grep` exits 1 on no match):
    `! grep -a 'new AbortController().signal' src/extensions/{compact,routing,drift-probe,goal,handoff,session}.ts` succeeds (no match).
- **Exit condition:** the site tests + both gates green; `npm test` green (0 fail); `npm run typecheck`
  0; `npm run eval` 5/5; `npm run build` 0 (final-phase full gate).

## 3. Engineering Constraints Index

- **Engineering norms** — `CLAUDE.md`: ESM `.js` specifiers even for `.ts`; strict TS
  (`noUncheckedIndexedAccess`); zero deps except jiti; lib/ pure (kernel types + Node only, no
  `ExtensionAPI`); a **ref'd** `setTimeout` (not `AbortSignal.timeout`) for the deadline; config via
  `e.config`; NO kernel change (only `src/extensions/*.ts`, new `src/extensions/lib/sub-call.ts`,
  `test/*`). Use `grep -a`/Read for non-ASCII source.
- **Four-corner template** — `~/.claude/skills/three-loop-workflow/references/loop-3-development.md`.
- **Commit conventions** — `feat(phaseN):`/`fix(phaseN-roundR): <keyword>`; result trailers; no
  AI/model/tooling mention.

## 4. Data and Fixture Dependencies

- Reuse `test/helpers.ts` `makeHarness` (injectable `LayeredConfig`; `h.config.set(...)` race-free vs
  env) and `MockProvider` (`providers/mock.ts`). The new shared `Hanging` provider is added to
  `test/helpers.ts` in T1.1. No new external fixtures.
- The site tests reuse each file's existing compaction-trigger / judge-invocation setup.

## 5. Regression Protection

Must stay green after each phase:
- `test/risk-guard.test.ts` (the reference; unchanged behavior — must pass whether or not it imports
  the shared `Hanging`), `test/compact.test.ts`, `test/routing.test.ts`, `test/drift-probe.test.ts`,
  `test/goal.test.ts`, `test/handoff.test.ts`, `test/session.test.ts`, `test/evals.test.ts`,
  `test/reasoning-search.test.ts` (+ `tree-search`/`graph-of-thought` if they exercise the judge path)
  — the adopting sites.
- Full suite `npm test`; final phase adds `npm run eval` (5/5) and `npm run build`.
