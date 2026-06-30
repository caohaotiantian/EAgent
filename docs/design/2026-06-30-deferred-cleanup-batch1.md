# Light-Mode brief — deferred cleanup batch 1 (RW9-1, RW1-2, RW7d-1)

**Slug:** `2026-06-30-deferred-cleanup-batch1` · **Tier:** Light (3 small, low-risk, independent fixes; no
breaking change, no new contract, no migration, no unresolved decision). Source: `docs/DEFERRED-FOLLOWUPS.md`.

## What / why

Three independent low-risk follow-ups from the post-Wave-9 register, each in a different file:

- **RW9-1 — otel last-batch hard-exit flush.** `agent_end` fires `void flush()` (unawaited, `otel-exporter.ts:225`)
  which drains the shared `finished` buffer (`finished = []`), so when `session_shutdown`'s **awaited**
  `flush()` runs it finds an empty buffer and returns `Promise.resolve()` — the last run's batch is still
  riding the *unawaited* `agent_end` POST and a `process.exit` immediately after a run can cut it. **Fix:**
  track the in-flight flush — `let lastFlush: Promise<void> = Promise.resolve();` set by the `agent_end`
  handler (`lastFlush = flush()`), and have `session_shutdown` `await lastFlush` (the actual in-flight POST)
  **then** `await flush()` (anything still buffered). Closes the hard-exit window. Telemetry-only.

- **RW1-2 — trace token display omits cache on a cached run.** `trace.ts:206`
  `tokens: in=${u.inputTokens} out=${u.outputTokens} total=${totalTokens(u)}` shows fresh input only — on a
  cached run `in=` is small while `total=` is large (already cache-aware), which reads as a contradiction.
  **Fix:** add a `cache=` field summing `cacheReadTokens + cacheWriteTokens`, shown **only when > 0** (so
  uncached output is byte-identical): `tokens: in=X [cache=Y ]out=Z total=T`. Display-only.

- **RW7d-1 — broaden the eval fixtures.** `evals/` has only 2 fixtures (`finish-clean`, `tool-sequence`).
  Add **3 more** deterministic, side-effect-free `*.eval.json` scenarios that exercise the so-far-unpinned
  `ExpectSpec` predicates (`order:"in_order"` subsequence, `maxSpans`, `maxTokens`, a parallel tool wave) —
  using the proven side-effect-free `todowrite` tool (as the existing `tool-sequence` fixture does) and
  text turns; no `read`/`write`/`edit`/`bash` (those touch the filesystem and are non-deterministic in the
  eval host). Each new fixture must PASS under `npm run eval`. Regression coverage only — no code change to
  the runner.

## Explicit non-goals

- NOT changing the otel trace structure, the agent_end fire-and-forget semantics for the live/mid-session
  case, or adding a metrics/logs signal (RW7c-1 stays deferred). RW9-1 only closes the shutdown race.
- NOT changing `totalTokens` or any accounting; RW1-2 is display text only.
- NOT adding statistical pass@k or an eval framework (DEFERRED #5 stays deferred); RW7d-1 is just more
  fixtures reusing the existing runner.
- NOT touching the other Wave-9 residuals (RW9-2/RW9-3 — reviewed and kept deferred) or any larger design.

## >1-option decision surfaced

- **RW9-1 — where to close the window:** (a) drop `agent_end`'s eager flush and only flush on
  `session_shutdown` — rejected: mid-session runs would not export until shutdown (worse for long sessions /
  live tracing); (b) **track the in-flight flush promise and await it on shutdown** — chosen: preserves
  eager per-run export AND guarantees the last batch is awaited before exit. This is the lower-risk pick
  with no behavior change to the common (non-shutdown) path.

## Acceptance command

`npm run typecheck` exit 0 · `npm test` exit 0 (existing + new otel/trace tests) · `npm run eval` exit 0
(now 5 fixtures, all pass) · kernel unchanged (no `src/kernel` edit). No new dependency.

## Closure

**Closed** (commit 8f191b7): RW9-1 — `lastFlush` tracked at agent_end, awaited at session_shutdown then a final flush. RW1-2 — `cache=` field in the trace token line, shown only when cache tokens > 0 (uncached output byte-identical). RW7d-1 — 3 new fixtures (parallel-wave, subsequence-in-order, text-only-budget); `npm run eval` 5/5. typecheck 0, npm test 1104, kernel 2186, no new dep.
