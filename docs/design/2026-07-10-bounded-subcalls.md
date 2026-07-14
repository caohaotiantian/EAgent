# Design — Bounded/abortable provider sub-calls (Batch D)

Slug: `2026-07-10-bounded-subcalls`
Status: closed
Closing-commit: Batch D closeout on `chore/production-hardening` (code commits from L3 phases 1–2 + closeout)
Closed-on: 2026-07-10
Deferred: finding — the AC2 `clearTimeout` spy asserts `≥1` (node:test itself calls `clearTimeout`, so it does not fail on a leaked timer); the helper provably clears in `finally` (verified in source + the F review), so the residual is a soft *test guard*, not a behavior gap. No repo issue tracker — tracked in the PR.

## 1. Background and Purpose

Several extensions make an LLM "sub-call" — a `provider.stream(...)` outside the main agent loop —
to summarize, classify, or judge. Eight of them run **without a deadline**, so a hung provider (open
connection, no data; `fetch` has no default timeout) hangs the sub-call — and, since most fire from a
`transformContext`/`turn_start`/`agent_end` hook, hangs the whole turn — with no cancellation path.

Source-verified sub-call sites (repo-wide `.stream(` grep, 8 leaky):

| Site | Trigger | Signal today | Timeout? |
| --- | --- | --- | --- |
| `compact.ts:193` (summarize) | `transformContext` hook | `new AbortController().signal` (fresh, never aborted) | no |
| `routing.ts:249` (classifyLlm) | `turn_start` event | fresh | no |
| `drift-probe.ts:249` (ask) | `turn_start` event | fresh | no |
| `goal.ts:336` (judge) | `agent_end` event / cmd | fresh | no |
| `handoff.ts:462` (summarize) | `agent_end` event / cmd | fresh | no |
| `session.ts:205` (summarize) | `/session` command | fresh | no |
| `evals.ts:490` (judge) | `judge` tool `execute` | `ctx.signal` (caller) | no |
| `reasoning-search.ts:203` (judgeScore) | `best_of_n`/`tree_search` `execute` | `ctx.signal` (caller) | no |

`risk-guard.ts:150-174` already bounds its classifier sub-call with a **ref'd `setTimeout` +
`AbortController`** (the fix that resolved an earlier CI flake) — the reference pattern. `fallback-
routing.ts` (composite provider passthrough), `recovery.ts`, `microagents.ts` make **no** sub-call
(refuted). The `AbortSignal.timeout` uses in `memory.ts`/`otel-exporter.ts` are on `fetch`, not
`provider.stream` (out of scope).

If we do nothing: any one of eight sub-calls can wedge a turn indefinitely — a table-stakes gap
(cancellation + timeouts) per the research.

## 2. Deliverables

- [ ] **D1** — New pure helper `src/extensions/lib/sub-call.ts`: `runSubCall(provider, req, opts)` that
      runs a tool-less completion to its `done` event under a **ref'd** deadline plus an **optional**
      caller `signal` (both drive one `AbortController`, both cleaned up in `finally`), and **throws**
      on timeout/abort; exports `DEFAULT_SUB_CALL_TIMEOUT_MS = 30_000`. Imports only kernel types +
      Node builtins (no `ExtensionAPI`). **The deadline path synthesizes its own error:** the timer
      callback sets a `timedOut` flag and aborts the controller; on the way out the helper throws a
      fresh `sub-call timed out after <ms>ms` (matching `/timed out/`) whenever `timedOut` is set —
      regardless of what the (possibly abort-triggered) stream itself threw — so a timeout is always
      distinguishable from a caller-abort or a provider error (the `Hanging` test provider rejects with
      its own generic message, not the timeout's, so the helper must not rely on the stream's error).
- [ ] **D2–D9** — Adopt `runSubCall` at all eight sites. The six hook/event/command sites pass **no**
      caller signal (deadline only); the two tool-execute sites (`evals`, `reasoning-search`) pass
      `ctx.signal`. Each site reads its per-extension timeout `config.int("<ext>.subCallTimeoutMs",
      DEFAULT_SUB_CALL_TIMEOUT_MS)`. The existing fail-open/fail-closed `catch` at each site is
      unchanged — it converts a thrown timeout to the site's existing fallback.
- [ ] **D10** — Lift a reusable `Hanging` provider (a stream that never yields, rejects on abort) into
      `test/helpers.ts` (currently private in `risk-guard.test.ts:367`) for the timeout tests.
- [ ] **D11** — Tests: helper unit tests (deadline fires → throws `/timed out/`; caller-abort → throws;
      a normal provider → returns the `done` `Message`; the timer is cleared on normal completion) +
      two representative site tests (a fresh-signal site — `compact` — falls back on timeout instead of
      hanging; a `ctx.signal` site — `evals` — `fail()`s on timeout). Each RED before its fix.

## 3. Scope Boundary (NOT in scope)

- **No main-agent-loop watchdog and no kernel change.** The kernel's own `provider.stream` await in
  `streamTurn` is bounded only by `stop()`, not a timeout; bounding it is a separate kernel-touching
  concern (deferred). This batch fixes the eight **extension** sub-calls only; `src/kernel/*.ts` is
  untouched.
- **No change to the `CompletionRequest`/`Provider` interface.** `runSubCall` takes the request minus
  `signal` and supplies the combined signal itself.
- **No change to `risk-guard`** (already correct; it is the reference and its `beforeToolCall` ctx has
  no signal anyway), to `fallback-routing`/`recovery`/`microagents` (no sub-calls), or to the
  `fetch`-side `AbortSignal.timeout` uses in `memory`/`otel-exporter`.
- **No change to the fail-open vs fail-closed disposition** at any site — the helper throws, the
  existing `catch` decides the fallback exactly as today.

## 4. Key Design Decisions

### KDD1 — Helper contract: throw on deadline/abort; return the `done` Message
- **Problem:** what should the helper do on timeout, and what does it return on success?
- **Options:** (A) throw on timeout/abort, return the final `done` `Message`; (B) swallow the timeout
  and return a sentinel (empty/undefined); (C) return the collected text string.
- **Choice: (A).** Every site already wraps its loop in a `catch` that produces the site's fallback
  (fail-open for compact/routing/drift-probe/goal/handoff/session/reasoning; fail-closed `fail()` for
  evals) — throwing routes a timeout straight into that existing disposition (matching `risk-guard`,
  whose aborted stream throws into `catch { return undefined }`). Returning the `Message` keeps the
  callers' own `textOf(...)`/parse logic unchanged. **Reject (B):** swallowing inside the helper would
  bypass and silently alter each site's fail-open/closed decision (a policy the site owns).
  **Reject (C):** loses the `Message` some sites may inspect, and duplicates `textOf` into the helper.

### KDD2 — Timeout configuration: per-extension key + shared default
- **Problem:** one global timeout, or per-site?
- **Options:** (A) each site reads `config.int("<ext>.subCallTimeoutMs", DEFAULT_SUB_CALL_TIMEOUT_MS)`
  with a shared exported default; (B) a single global `subCall.timeoutMs`; (C) a hardcoded constant.
- **Choice: (A).** A slow `compact` summarize and a fast `routing` classify have genuinely different
  reasonable bounds; a per-extension key (defaulting to one shared, documented constant) gives
  operators a lever without proliferating unrelated tunables. Mirrors `risk-guard.timeoutMs`.
  **Reject (B):** forces one bound on dissimilar sub-calls. **Reject (C):** not tunable for a slow
  backend. Default `30_000` ms — generous for a tool-less single completion, far below "forever".

### KDD3 — Caller signal is OPTIONAL (the decisive constraint)
- **Problem:** can every site supply the caller's abort signal?
- **Evidence:** the kernel omits `signal` from hook contexts (`events.ts:70-71` transformContext/
  transformRequest/beforeToolCall/afterToolCall) and event payloads; only a tool `execute` gets
  `ctx.signal` (`types.ts:154-164`, set from the run controller at `agent.ts:521`). So the six
  hook/event/command sites have **no** caller signal; the two tool sites do.
- **Options:** (A) optional `signal?` — timer-only where absent, timer+signal where present; (B)
  require a signal at every site (impossible for hooks); (C) always timer-only (drop the caller link at
  the two tool sites).
- **Choice: (A).** It fits both site classes with one helper, exactly the `mcp.ts#post` shape (optional
  `signal`, unconditional timer). **Reject (B):** a hook has no signal to give. **Reject (C):** would
  regress the two tool sites, which SHOULD honor a user's mid-run abort — cancellation is table-stakes.

## 5. Dependencies and Assumptions

- **`CompletionRequest`** (`types.ts:252-268`): `signal: AbortSignal` is required; the helper accepts
  `Omit<CompletionRequest, "signal">` and injects the combined signal.
- **Reference patterns:** `risk-guard.ts:150-174` (ref'd timer, clear in `finally`), `mcp.ts:436-456`
  (`#post`: deadline + optional caller signal, both drive one controller, both cleaned up),
  `self-improve.ts:152-197` (same combine idiom with already-aborted guard + `removeEventListener`).
  There is **no** `AbortSignal.any` in the tree (deliberately — it types poorly under lib ES2023); the
  helper hand-combines like the references.
- **Stream shape:** the sub-call ends in exactly one `{ type: "done"; message; ... }`
  (`types.ts:246-250`); the helper collects that message.
- **Every site's `catch`** is a genuine fail-open (returns a fallback) or fail-closed (`fail()`); a
  thrown timeout is handled there — verified per site (§1 table refs).
- **Test infra:** `test/helpers.ts` `makeHarness` gives an injectable `LayeredConfig` (`h.config.set`,
  race-free vs env); the `Hanging` provider template is `risk-guard.test.ts:367-378`;
  `MockProvider.stream` at `mock.ts:68`.
- **Measured baseline (this branch):** `npm test` 1302 pass / 0 fail / 1 skip; typecheck 0; eval 5/5;
  build 0.

## 6. Relationship with Existing Designs

- Generalizes the `risk-guard` timeout fix (its CI-flake resolution) into a shared helper adopted by
  the other eight sub-calls; no conflict (`risk-guard` itself is left as-is, the reference).
- No conflict with the provider-honesty batch (`2026-07-10-provider-honesty`): that handled the MAIN
  stream's error frames; this bounds the SUB-call streams. Different streams, complementary.
- Orthogonal to the same-branch `2026-07-10-bounded-subagents` (which bounds the sub-*agent* recursion
  tree via child-registry capability filters); this bounds sub-*call* deadlines — different surfaces,
  no shared site. No warning marker required. Config keys follow the `2026-07-07-centralized-config`
  facility (`config.int`).

## 7. Acceptance Criteria (measurable / automatable)

- **AC1 (helper):** `runSubCall(hangingProvider, req, {timeoutMs:50})` rejects with `/timed out/` within
  a short bound; `runSubCall(mockProvider, req, {timeoutMs:5000})` resolves to the `done` `Message`
  whose text is the mock's scripted output. Command: `node --import tsx --test test/sub-call.test.ts`.
- **AC2 (caller abort + timer cleared):** `runSubCall(hangingProvider, req, {timeoutMs:5000, signal})`
  where `signal` aborts at ~20 ms rejects (caller-abort wins the race). Timer-clearance is asserted
  **directly** (not via wall-clock): spy on `clearTimeout` (e.g. `t.mock.method(globalThis,
  "clearTimeout")` or a wrapper) and assert it is called on a normal resolve **and** on the timeout/
  abort paths — so a leaked ref'd timer (which node:test does not fail on by default) is caught. Same
  file.
- **AC3 (site behavior):** with a `Hanging` provider and `compact.subCallTimeoutMs=50`, `compact`'s
  `transformContext` returns its fallback (the un-summarized message list / `renderFallback`) rather
  than hanging (the whole test completes < 1 s). With `evals.subCallTimeoutMs=50`, the `judge` tool
  returns a `fail()` result on timeout. Commands: `node --import tsx --test test/compact.test.ts
  test/evals.test.ts`.
- **AC4 (no leaky site remains):** a mechanical positive gate —
  `grep -la 'lib/sub-call.js' src/extensions/{compact,routing,drift-probe,goal,handoff,session,evals,reasoning-search}.ts`
  lists all eight; and the negative gate scoped to the six fresh-signal files —
  `grep -a 'new AbortController().signal' src/extensions/{compact,routing,drift-probe,goal,handoff,session}.ts`
  returns no match (they now route through the helper). (The `*.ts`-wide grep would falsely match
  `codeact.ts:288`, an out-of-scope code-exec abort — so the gate is deliberately scoped to the six.)
- **AC5 (gates):** `npm test` green (1302 prior + new tests, 0 fail); `npm run typecheck` 0;
  `npm run eval` 5/5; `npm run build` 0.

## 8. Risks and Rollback

- **R1 — throwing changes site behavior on timeout.** Intended: each site's existing `catch` converts
  the throw to its established fallback (fail-open returns the pre-summarization/​neutral result;
  fail-closed `evals` returns `fail()`). Verified per site. A site whose `catch` is narrower than
  `catch (e)` could miss it — the impl must confirm each `catch` is unconditional. Rollback: revert the
  per-site adoption (each is independent).
- **R2 — default 30 s too short/long.** Generous for a tool-less completion; per-site configurable.
  Rollback: raise the default or the site key.
- **R3 — the two `ctx.signal` sites now honor both deadline AND caller abort** (previously caller-only,
  no deadline). This is the intended improvement; a caller abort still propagates. Rollback: pass
  `signal` only.
- **R4 — lifting `Hanging` into `helpers.ts`** could collide with `risk-guard.test.ts`'s private copy.
  Mitigation: `risk-guard.test.ts` keeps working whether it imports the shared one or keeps its own;
  the batch does not have to touch it. Rollback: keep `Hanging` per-test.
- **Overall:** extension + lib + tests only; each site independently revertible; branch
  `chore/production-hardening`, PR-gated.
