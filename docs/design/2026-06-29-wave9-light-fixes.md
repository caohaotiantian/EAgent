# Design — Wave 9 light fixes (W9.4 + W9.5 + W9.6)

**Slug:** `2026-06-29-wave9-light-fixes` · **Wave:** 9 (subsystems W9.4–W9.6) · **Mode:** Light
**Source:** [`docs/audits/2026-06-29-production-readiness-audit.md`](../audits/2026-06-29-production-readiness-audit.md).

Three independent subsystems of small, well-specified fixes touching disjoint files (reasoning-search;
limits/gemini/provenance; server/otel/memory/time-travel) — no kernel change, no cross-conflicts. Grouped
under one Light-mode doc; each deliverable is independently revertible. Every fix preserves the no-child /
common-path behavior.

---

## W9.4 — reasoning-search fork robustness

**Gap (audit §3):** `best_of_n` forks via `Promise.all(children.map(c => c.run(task)))`
(`reasoning-search.ts:221`) with (a) **no abort wiring** — a parent `stop()`/`ctx.signal` abort is ignored
until every fork finishes, and `Agent.run` takes no signal (each child owns its own `#abort`,
`agent.ts:215/221`); and (b) **no per-child catch** — one fork's throw rejects the whole `Promise.all`,
discarding the N-1 completed forks, even though the judge scorer is fail-soft (`:170-172`).

- [ ] **D-W9.4a (cancellable forks):** in `best_of_n`'s `execute(args, ctx)`, register a `ctx.signal` abort
  listener that calls `child.stop()` on every fork (the children refs are in scope), and remove the listener
  in a `finally`. A parent abort now tears down in-flight forks promptly.
- [ ] **D-W9.4b (one throw ≠ total failure):** replace `Promise.all` with `allSettled`; a **rejected** fork
  is assigned `score: -Infinity` **directly** (never run through the scorer — review: `""` through
  `shortest` is `-0 === 0` and could *win*), so it can never be the argmax, while completed forks are
  scored normally. If **all** forks reject, return a clean `fail(...)`.
- **AC-W9.4** (note: `MockProvider` has no delay/throw primitive and all forks + the judge share one
  provider — so these tests need a **custom `Provider`**, not MockProvider): (1) a provider that **blocks
  until `signal` aborts**; with `ctx.signal` aborted mid-run, assert every fork received `stop()` and
  `best_of_n` returns/rejects promptly. (2) a provider that **throws** (discriminating a fork run from a
  judge call via `systemPrompt === JUDGE_SYSTEM_PROMPT`) for one fork → `best_of_n` returns the best
  survivor; all forks throw → clean `fail`.

---

## W9.5 — accounting & provider edges

- [ ] **D-W9.5a (RW1-1 — budget counts cache tokens):** `limits.ts:208` does
  `tokensThisRun += usage.inputTokens + usage.outputTokens`, omitting the disjoint cache tokens that
  providers now populate. Replace with `tokensThisRun += totalTokens(usage)` (cache-aware, `types.ts:240`,
  excludes `reasoningTokens` which is already inside `outputTokens`; used by `trace.ts`/`evals.ts`). **Add a
  *value* import** of `totalTokens` from `../kernel/types.js` (limits.ts currently imports only the
  `ToolResult` *type*). Restores the runaway-stop guarantee on cached runs. **AC:** a `usage` with
  `cacheReadTokens` set advances `tokensThisRun` by the cache-inclusive total (unit).
- [ ] **D-W9.5b (RW6d-1 — Gemini empty-`parts` replay 400):** a reasoning-only assistant turn (MAX_TOKENS
  truncation → `content=[{thinking}]`, `gemini.ts:147`) is replayed by `toGeminiContents`, which drops the
  thinking block and still `out.push({ role, parts: [] })` (`gemini.ts:208`) → `generateContent` rejects an
  empty `parts`. Fix in the request builder: **skip** (or stub with a single empty-safe text part) any
  assistant message whose mapped `parts` is empty. **AC:** building contents from a transcript containing a
  thinking-only assistant message yields **no** `parts:[]` entry (unit, offline — pure builder).
- [ ] **D-W9.5c (provenance nested-arg scan):** `provenance.ts:99` iterates `Object.values` at the **top
  level** and `continue`s on non-strings, so string leaves nested in objects/arrays in tool args are never
  inspected — and `mcp:call` (a default sink) registers arbitrary nested params. Fix: **recursively** walk
  string leaves of nested args (bounded depth to avoid pathological nesting). Off by default; best-effort
  CaMeL-lite, so still defense-in-depth, not a hard boundary — but closes the documented blind spot. **AC:**
  a tool arg with a tainted string nested one+ levels deep is detected by the gate (unit).

---

## W9.6 — HTTP bind safety + minor batch

- [ ] **D-W9.6a (refuse dangerous bind):** the server defaults `yolo:true` → `fallback:"allow"`
  (auto-grant every capability, `host.ts:214`) and `token:""` with auth enforced only `if (security.token)`
  (`server.ts:186`); a non-loopback bind (`EAGENT_HOST=0.0.0.0`) with an empty token is only **warned**
  (`server.ts:123-128`). Fix: **refuse to start** (throw) when the bind address is non-loopback **and**
  `EAGENT_TOKEN` is empty — fail-closed on the dangerous combination. **Plumb the host through:** `main()`
  currently reads `EAGENT_HOST` at `server.ts:407` and passes only `{ port }` to `createHttpServer` (`:408`)
  — add a `host` field to `ServeOptions` (default `EAGENT_HOST ?? "127.0.0.1"`) and run the guard **inside**
  `createHttpServer` (which never `listen`s → naturally pre-bind + unit-testable). Default (`127.0.0.1`) and
  token-set cases unaffected. **AC:** `createHttpServer({ host: "0.0.0.0" })` with empty token throws; with
  a token, or with loopback, it constructs (unit, no real listen).
- [ ] **D-W9.6b (otel flush on shutdown):** `flush()` is `(): void` doing `void fetch(...)` and
  `session_shutdown` doesn't await it (`otel-exporter.ts:84,96-100,192`), so the final batch is dropped on
  hard exit. Fix: have **`flush()` return its `fetch` promise** and make the `session_shutdown` handler
  `async` + `await flush()` (`emit` awaits each handler serially, `hooks.ts:89-100`, so this blocks until the
  export resolves; bounded by the existing 5s `AbortSignal.timeout` if the collector is down — acceptable,
  opt-in). Leave the `agent_end` call (`:189`) unawaited (no regression). **AC:** a `session_shutdown` after
  buffered spans performs the export `fetch` before resolving (stub `globalThis.fetch`; assert called).
- [ ] **D-W9.6c (memory consolidate lowest-`ts`):** `memory.ts:261` "keep earliest" actually keeps
  first-by-key-iteration; an overwrite bumps `ts` without changing insertion order, so the genuinely
  earliest copy can be deleted. Fix: select the survivor by **lowest `ts`** via the existing `lowestByTs`
  helper (`memory.ts:148` — already used in `evictIfOverCap` `:345/:351`, so reuse it; it is *not* unused).
  Note `ts` is last-write time (legacy entries `ts:""` sort first), so "lowest ts" = least-recently-written
  / legacy-first — a deterministic survivor rule. **AC:** consolidating duplicates where the later-inserted
  has the lower `ts` keeps the lowest-`ts` entry (unit; strengthen the existing count-only assertion).
- [ ] **D-W9.6d (time-travel snapshot guard + blob shape check):** root cause — `Agent.restore` is
  **non-atomic**: it clears `#messages` (`agent.ts:205`) *before* the throwing
  `push(...structuredClone(state.messages))` (`:206`), so a malformed blob wipes the transcript even though
  `/rewind` catches the throw (`time-travel.ts:241-244`). Fix (extension-side, no kernel change): wrap the
  manual `/checkpoint` snapshot (`time-travel.ts:208`) like the auto/fork paths, and add a minimal
  `AgentState` **shape check before `restore`** mirroring `session.ts:237-249` (+ the exported `isMessage`,
  `types.ts:99`); **allow `providerName: undefined`** (the field is `string | undefined`, `types.ts:326` —
  don't over-tighten). **AC:** a malformed blob is **rejected before `restore`** (transcript intact), with a
  clear error; a valid snapshot (incl. `providerName` undefined) restores (unit).

---

## Engineering constraints (all of W9.4–W9.6)

ESM NodeNext `.js` specifiers; strict TS (`noUncheckedIndexedAccess`); zero deps but jiti; offline tests
(MockProvider; stub `fetch` for otel/server; pure builders for gemini/provenance); **no kernel change**;
each extension keeps its kill-switch/off-default behavior. Every fix is additive and preserves the
common-path (no-abort / no-cache / loopback / well-formed-blob) behavior byte-for-byte. Closing-commit per
subsystem recorded at F.

## Risks

- **W9.4 allSettled selection:** ensure a rejected fork can never be the argmax (use `-Infinity`/drop).
- **W9.6a:** must guard **before** binding; do not break the documented loopback-yolo dev posture.
- **W9.6d:** the shape check must accept all real snapshots (mirror `session.ts:237-249`, don't over-tighten).
- All: backed by AC unit tests; revert any deliverable independently.
