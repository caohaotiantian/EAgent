# Design — kernel defensive-robustness pass (FRESH-1, FRESH-2, FRESH-4)

**Slug:** `2026-06-30-kernel-robustness` · **Tier:** Full · **Branch:** off `init`
**Source:** the 2026-06-30 deferred/production-readiness verification audit (register-blind fresh
sweep of `src/kernel/`). These three are *not* in `docs/DEFERRED-FOLLOWUPS.md` — they are newly
surfaced defects in the kernel primitives, the only HIGH-severity item in the audited set among
them.

## 1. Background and Purpose

The kernel is "the one piece that must be small, correct, and observable" (`agent.ts:4`). The
register-blind sweep found three defensive gaps in the kernel primitives where a real-world input
the offline test suite never exercises produces a wrong outcome:

- **FRESH-1 (HIGH) — a user cancel mid-stream is mis-reported as a failure.** When `stop()` aborts
  *during* an in-flight provider stream, a real `fetch`-based provider rejects the stream with an
  `AbortError`. `streamTurn` rethrows it (post-commit, `agent.ts:420-422`) and `run()`'s catch
  (`agent.ts:337-340`) turns it into `reason:"error"`, **emits an `"error"` event**, and **rethrows**
  so `run()` rejects. A normal cancellation therefore (a) emits spurious error telemetry that trips
  error-counting guards (`circuit-breaker`, `limits`), and (b) makes the caller's `await run()`
  throw. The only existing `stop()` test (`agent.test.ts:282-303`) aborts *between* provider calls,
  and `MockProvider` breaks gracefully on `signal.aborted` instead of throwing (`mock.ts:81,90`), so
  the offline suite is green while production diverges silently.

- **FRESH-2 (low) — `maxConcurrency <= 0` crashes the dispatch wave.** `maxConcurrency` is stored
  unvalidated (`agent.ts:132`). A value of `0` skips the `=== Infinity` fast path, sets
  `poolSize = Math.min(0, n) = 0`, and `Array.from({ length: 0 }, worker)` (`agent.ts:468`) spawns
  zero workers, so the `results` array stays sparse (all holes). The `tool_batch_end`
  `results.map(...)` at `agent.ts:291` does **not** throw (`Array.prototype.map` skips holes); the
  crash lands one step later in the `reconciled` build, `results.find((r) => r.call.id === oc.id)` at
  `agent.ts:303`, because `Array.prototype.find` **visits** holes as `undefined` ⇒
  `undefined.call` ⇒ `TypeError`. A **negative** value does not throw `RangeError`: `Array.from`
  clamps a negative `length` to `0` (and the result array at `agent.ts:459` uses `calls.length`, not
  `poolSize`), so it degrades to the **same** empty-pool → sparse-`results` → TypeError-at-`find`
  path as `0`. Either way an operator misconfig becomes an opaque crash with zero tool execution.
  (All three mechanics repro-verified.)

- **FRESH-4 (low) — corrupt store JSON is silently overwritten (persistent data loss).**
  `FileStore.read()` (`store.ts:81-87`) catches *every* read/parse failure and returns `{}`,
  conflating "file does not exist yet" (the normal first run) with "the file exists but is corrupt"
  (crash-truncated or hand-edited JSON). In the corrupt case the FileStore starts empty and the next
  `set()`/`delete()` calls `flush()` (`store.ts:88-95`), which **atomically renames a fresh `{}` over
  the corrupt file**, destroying every persisted key (memory notes, journal, extension flags) with no
  signal.

If we do not fix these: cancellation remains a first-class production path that looks like an error
(noisy telemetry + thrown caller + guard false-positives); a single bad `maxConcurrency` value bricks
all tool dispatch; and a power-loss-truncated store file is destroyed on the next write instead of
preserved for recovery.

## 2. Deliverables

- [ ] **FRESH-1**: `run()`'s catch distinguishes an abort-caused stream rejection from a genuine
  error. When `this.#abort.signal.aborted` is set, the run ends `reason:"stop"` with **no** `"error"`
  event and **no** re-throw (`run()` resolves). When the signal is *not* aborted, the existing
  `reason:"error"` + `emit("error")` + re-throw path is byte-for-byte preserved.
- [ ] **FRESH-2**: the `Agent` constructor clamps `maxConcurrency` to a floor of `1`; `undefined`
  still defaults to `Infinity` (full parallelism) and any finite `>= 1` value is unchanged.
- [ ] **FRESH-4**: `FileStore.read()` returns `{}` silently only when the file is absent; when the
  file exists but cannot be parsed, it **best-effort** renames the file aside to a
  `${path}.corrupt-<pid>-<epoch-ms>` backup before returning `{}`, so a later `flush()` does not
  destroy the original bytes — *unless the rename itself fails*, which degrades to today's overwrite
  behavior (never a new throw). (Consequence: opening a store on a corrupt file is no longer
  side-effect-free — see D3.)
- [ ] New offline tests: a custom-provider FRESH-1 test (abort mid-stream ⇒ `reason:"stop"`, no throw,
  no `error` event) plus a genuine-error regression assertion; a `maxConcurrency=0` **and** negative
  dispatch test; a new `test/store.test.ts` covering absent-file, valid-file, and corrupt-file-backup
  paths (all driven through the exported `FileBackend.open()`).
- [ ] `src/kernel/` total stays `< 2200` lines by the **kernel-surface metric**
  (`split("\n").length` summed over `src/kernel/*.ts`; baseline **2198**, not the `wc -l` 2186), and
  the public kernel surface (exports) is unchanged. Net additions are offset by compressing equivalent
  comment lines in the touched methods/files (see D4).

## 3. Scope Boundary (NOT in scope)

- **No public API / type changes.** No new export, no `AgentOptions` field, no `StoreBackend`/`Store`
  interface change. The kernel-surface export pin must stay green.
- **No new behavior for the `maxConcurrency` *upper* path** — only the `<= 0` lower bound is clamped;
  fractional and large values keep their current (working) behavior.
- **No logger plumbing into the storage layer.** FRESH-4 does not thread a `Logger` into
  `FileBackend`/`FileStore` (it has none today); the `.corrupt-*` backup file is the recovery signal.
  Adding a warn-log channel to the store is explicitly deferred (would touch `FileBackend`'s
  constructor + `open()` for marginal benefit over the backup file).
- **No kernel-ceiling raise.** Staying `< 2200` is honored by compressing equivalent comment lines
  in the touched methods (D4), **not** by raising the ceiling — the `< 2200` bet is the kernel's
  signature constraint (CLAUDE.md, `kernel-surface.test.ts:69`) and these are bug-fix lines, not new
  capability, so they should fit within the existing budget. Raising the ceiling (its own
  load-bearing contract decision) is explicitly out of scope.
- **No corrupt-backup retention / GC policy.** Backups accumulate; pruning them is out of scope (a
  corrupt store is a rare, investigate-then-delete event, not a steady state).
- **No change to `flush()`'s atomic-write path, `streamTurn`'s retry loop, `onProviderError`, or the
  between-call abort checks** (`agent.ts:244-247,252-255`) — those already work and are pinned.
- **No new dependency.** Node built-ins only (`node:fs` already imported in `store.ts`).
- **Quality budget:** these are correctness fixes on cold/error paths, not hot-path or
  user-facing-latency changes; no performance budget applies. The only measurable budgets are the
  kernel line ceiling (`< 2200`) and `npm test`/`npm run eval`/`typecheck` exit 0 — all declared in
  Acceptance.

## 4. Key Design Decisions

### D1 — FRESH-1: detect cancellation by `signal.aborted`, not by error type

- **Problem:** in `run()`'s catch, decide whether a thrown error is "the user cancelled" (→ clean
  stop) or "the provider/loop genuinely failed" (→ error).
- **Options:**
  1. **Inspect the error** — check `err instanceof DOMException && err.name === "AbortError"` (or
     `err.name === "AbortError"`).
  2. **Inspect the signal** — `this.#abort?.signal.aborted` (chosen).
  3. Catch the abort *inside* `streamTurn` and convert it to a sentinel return.
- **Choice: option 2.** The abort signal is the single source of truth for "the user requested a
  stop", independent of which error type a given provider/`fetch`/runtime throws on abort (DOMException
  `AbortError`, a wrapped error, or a provider-specific shape). Option 1 is brittle across providers
  and runtimes. Option 3 spreads cancellation logic into the retry loop and would have to thread a
  new return shape through `streamTurn`'s signature for no gain. `this.#abort` is still defined in the
  catch (the `finally` clears it *after*, `agent.ts:343`), so the check is safe. Reading the signal
  also correctly classifies an abort that surfaces as a *pre-commit* throw (provider rejects before the
  first event) the same way as a post-commit one.
- **Rejected:** option 1 — provider-coupled, fragile. Option 3 — invasive, no benefit.
- **Semantics preserved:** when the signal is *not* aborted, the catch is unchanged
  (`reason:"error"` + `emit("error")` + `throw`), so `agent.test.ts:763` (pre-commit genuine error ⇒
  `reason:"error"` + rethrow) still passes. A between-call abort already yields `reason:"stop"` with no
  error event (`agent.ts:244-247,252-255`), so the mid-stream case now matches it — one consistent
  cancellation contract.

### D2 — FRESH-2: clamp to a floor of 1, silently (a sane default, not a throw)

- **Problem:** an invalid `maxConcurrency <= 0` reaches dispatch and crashes.
- **Options:** (a) **clamp** `Math.max(1, value)` in the constructor (chosen); (b) **throw** in the
  constructor on `<= 0`; (c) validate at the dispatch site.
- **Choice: (a) clamp at construction.** Matches the kernel's existing tolerant style — `maxTurns` is
  likewise stored without validation, and the constructor already normalizes defaults with `??`. A
  clamp turns a misconfig into the most conservative working behavior (one tool at a time) rather than
  a hard failure at agent construction, which could break a host at startup. `Math.max(1, Infinity)`
  is `Infinity`, so the default and the fast path are unchanged; `Math.max(1, N>=1)` is `N`, so valid
  values are untouched — only `<= 0` moves to `1`. Repro-confirmed: `Math.max(1, 0) === 1`,
  `Math.max(1, -5) === 1`, `Math.max(1, Infinity) === Infinity`. Because `0` and a negative value
  crash identically (both → empty pool → TypeError at `agent.ts:303`), the single clamp covers both.
- **Rejected:** (b) throwing relocates the same crash to construction (an operator typo shouldn't
  brick the host) and adds a new failure mode callers must handle; (c) clutters the hot dispatch path
  with a guard for a construction-time mistake. A `warn` on clamp was considered and rejected under
  Simplicity First — the constructor does not log defaults today, and `Infinity` means the field is
  rarely set at all.

### D3 — FRESH-4: distinguish absent vs corrupt with `existsSync`; preserve corrupt bytes via rename-aside

- **Problem:** `read()` must keep returning `{}` for the normal absent-file first run, but must NOT
  let a corrupt existing file be silently overwritten by the next `flush()`.
- **Options:**
  1. **`existsSync` guard + back-up-on-parse-failure** (chosen): `if (!existsSync(path)) return {}`;
     else parse; on parse failure `renameSync(path, path.corrupt-<ts>)` (best-effort) then `{}`.
  2. **Branch on `err.code === "ENOENT"`** inside a single try/catch around read+parse.
  3. **Thread a `Logger`** into `FileStore` and warn (no backup).
- **Choice: option 1.** It is the smallest diff that fixes the actual defect: the rename *preserves*
  the original bytes (recoverable) so the next `flush()` writes a new file rather than destroying
  data. This is **best-effort**: the rename is wrapped in an inner `try`, so if the rename itself fails
  the original corrupt file remains and the next `flush()` still overwrites it (today's behavior) — the
  fix removes the throw risk and closes the loss for the overwhelmingly common case (a renamable file),
  but it is not an absolute guarantee. `existsSync` cleanly separates "nothing to lose" (absent ⇒ silent `{}`, byte-identical
  to today's first-run behavior) from "a real file we failed to load" (exists ⇒ back up). The
  best-effort inner `try` around the rename means even an un-renameable file degrades to today's
  behavior (`{}`), never a throw. `Date.now()` is available in kernel runtime — already used at
  `capabilities.ts:135` (only Workflow scripts forbid it).
- **Backup filename:** `${path}.corrupt-${process.pid}-${Date.now()}`. The `process.pid` segment
  (already used by `flush()`'s tmp name, `store.ts:92`) avoids two same-millisecond corrupt opens
  overwriting each other's backup; a same-pid same-ms collision is accepted as negligible (a single
  process opens a given namespace's `FileStore` once, cached by `FileBackend`, `store.ts:56-58`).
- **Side-effect note:** `read()` runs in the `FileStore` constructor (`store.ts:65`), so today
  `open()` is a pure read. On the corrupt path this fix performs a `renameSync` at open/construction
  even if the caller never writes. This is the intended behavior (preserve the bytes) and is the
  smallest place to catch the loss, but it is a real behavior change recorded here and pinned by
  AC#4(c).
- **Rejected:** option 2 is functionally close but keeps a single catch that also swallows
  post-`readFileSync` `EACCES`/`EISDIR` identically — the `existsSync` split reads more clearly and the
  TOCTOU window (file deleted between `existsSync` and `readFileSync`) degrades safely to `{}`. Option
  3 needs constructor/`open()` plumbing through `FileBackend` for a log line; the backup file already
  records the event durably and is the better forensic artifact. The backup-vs-warn trade is recorded
  here so the deferred warn channel is a documented choice, not an omission.

### D4 — kernel line ceiling: offset additions with comment compression, do not raise the ceiling

- **Problem:** the kernel is at **2198/2200** by the kernel-surface metric (`split("\n").length`
  summed over `src/kernel/*.ts`, `kernel-surface.test.ts:67`) — **1 line of headroom**, not the 13
  the `wc -l` figure (2186) suggested. The three fixes add net ≈ +5 raw lines (FRESH-1 catch +3,
  FRESH-4 `read()` +2, FRESH-2 +0), which would breach `< 2200`.
- **Options:** (a) **offset the additions by compressing equivalent comment lines** in the touched
  methods so net ≤ +1 (final ≤ 2199, chosen); (b) **raise the ceiling** (e.g. to 2210) — update the test +
  CLAUDE.md; (c) drop a fix (FRESH-2 is +0, so only FRESH-1/FRESH-4 are at stake — dropping either
  forfeits the fix).
- **Choice: (a).** Staying `< 2200` is the kernel's defining bet ("grown only by deepening shared
  seams, never by features"); these are correctness lines, not new capability. The offset is taken
  **only from the abort-handling comment in `run()` (`agent.ts:238-243`, 6 lines)**: FRESH-1 makes the
  catch a *third* abort-handling site (after the two in-loop checks that comment documents), so the
  comment is rewritten to state "three guards … all end the run `reason:"stop"`" and compressed
  6→~2 lines (saving ~4) — an in-scope edit to the method FRESH-1 already changes. That offsets the
  +5 additions to net ≈ +1 (final ≈ **2199 < 2200**). The store-side `read()` addition is kept as tight
  as possible within `read()`'s own body (no standalone explanatory comment), so **`flush()` is left
  untouched** (honoring §3's "no change to `flush()`"). L2 produces the **exact byte-accounted offset
  before any edit**; if +1 proves to breach (or a cleaner net-0 is wanted) the savings are sourced
  only from the two methods FRESH-1/FRESH-4 already touch — never `flush()` or unrelated code, and
  never by raising the ceiling (escalate instead).
- **Rejected:** (b) raising the ceiling contradicts the program's signature achievement and is itself
  a load-bearing-doc (CLAUDE.md) contract change warranting separate surfacing/sign-off — a poor
  trade for ~5 lines. (c) dropping a fix forfeits a real defect (FRESH-1 is HIGH-severity).

## 5. Dependencies and Assumptions

- No external systems. Node `node:fs` (`existsSync` added to the existing `store.ts` import — same
  import line, no new line), `node:async_hooks` (already used), the `AbortController`/`AbortSignal`
  globals (already used).
- Assumes `MockProvider` is insufficient to exercise FRESH-1 (it breaks gracefully on abort rather than
  throwing); the FRESH-1 test therefore defines a tiny inline provider that yields one `text_delta`
  then throws when `signal.aborted`, emulating a real `fetch` provider.
- Assumes the kernel-surface line ceiling counts `split("\n").length` summed over `src/kernel/*.ts`
  (verified `test/kernel-surface.test.ts:60-70`); net additions must keep the total `< 2200`. The
  metric baseline is **2198** (re-computed with the test's own formula; the `wc -l` value is 2186,
  which differs by +1/file × 12 files = +12). True headroom is **1 line**, so the additions are offset
  by comment compression (D4) to net ≈ +1 (final ≈ 2199 < 2200).

## 6. Relationship with Existing Designs

- **`docs/design/2026-06-28-reliability-boundary.md`** (`onProviderError` seam) — FRESH-1 sits in the
  same `streamTurn`/`run()` error path but is orthogonal: that seam handles *pre-commit provider
  failures* (retry/downshift); FRESH-1 handles *cancellation* surfacing after the throw escapes the
  seam. No conflict; the `MAX_PROVIDER_RETRIES` bound and the pre-commit/post-commit split are
  untouched. Note the pre-existing interaction (unchanged, and out of FRESH-1's scope): a *pre-commit*
  abort is first offered to any registered `onProviderError` handler (`agent.ts:423-427`); a
  `retry:true` handler re-streams *inside* `streamTurn`'s retry loop (`continue`, `agent.ts:428-431`),
  so an aborted re-stream that throws loops there until `MAX_PROVIDER_RETRIES` exhausts and then throws
  to `run()`'s catch, while one that returns a normal turn is caught by the **post-`streamTurn`** abort
  check (`agent.ts:252-255`). End state is `reason:"stop"` either way. FRESH-1's catch governs the
  abort-throw that actually escapes to `run()` — the post-commit case (the common one) and the
  no-handler pre-commit case.
- **`docs/design/2026-06-28-forkable-state.md`** (snapshot/restore, `#step`) — unaffected; FRESH-1 only
  changes how an already-aborted run reports `reason`/throws, not transcript or step state.
- **`docs/design/2026-06-29-governed-subagents.md` / W9.1 acting-agent seam** — FRESH-1 makes
  cancellation *not* emit `"error"`, which is the correct direction for the error-counting guards
  (`circuit-breaker`, `limits`) wired in W9.1: a user cancel must not increment their error tallies.
  Reinforces, does not conflict.
- **`docs/DEFERRED-FOLLOWUPS.md`** — none of FRESH-1/2/4 appears there; they are new findings. No prior
  design models `FileStore.read()`'s corrupt-file behavior. No terminology conflict; "acting agent",
  "wave", "dispatch", "flush" all used per existing usage.
- Terminology anchors: CLAUDE.md (kernel primitive table, capabilities, house conventions), README
  extension table.

## 7. Acceptance Criteria (measurable / automatable)

1. **FRESH-1 cancel path:** a new `agent.test.ts` test registers a provider that yields one
   `text_delta` then, on its **next** iteration, `throw`s an `AbortError` when `req.signal.aborted`
   (emulating a real `fetch` provider rejecting an in-flight stream). The abort MUST fire **in-stream**:
   a `text_delta` hook listener (`agent.hooks.on("text_delta", () => agent.stop())`) calls `stop()`
   while the provider stream is being consumed, so the provider's next yield throws and the error
   reaches `run()`'s catch (`agent.ts:337-340`). (A *tool* calling `stop()` does NOT exercise this
   path — a tool runs only after `streamTurn` returns, producing the already-covered *between-call*
   stop at `agent.ts:244-247`/`:252-255`; the provider is never re-entered, so the catch is never
   hit.) Assert: `run()` **resolves** (no rejection), `result.reason === "stop"`, and **no `"error"`
   event** was emitted (a bus listener on `"error"` recorded zero calls). PASS = test green.
2. **FRESH-1 genuine-error regression:** the same/companion test asserts a provider that throws
   pre-commit with the signal **not** aborted still yields `reason:"error"` and `run()` rejects
   (re-confirms `agent.test.ts:763` semantics under the new branch). PASS = test green.
3. **FRESH-2 clamp:** new `agent.test.ts` tests construct agents with `maxConcurrency: 0` **and**
   `maxConcurrency: -1`, each driving a two-`tool_call` parallel wave, and assert both tools executed
   and the run completed with a normal reason (no `TypeError` at the `reconciled` `find`, no crash).
   PASS = tests green.
4. **FRESH-4 store paths:** a new `test/store.test.ts` drives every path through the exported
   `FileBackend(root).open(namespace)` (the corrupt fixture written to
   `join(root, sanitize(namespace) + ".json")`, since `FileStore` is private) and asserts: (a) an
   absent path yields `keys() === []` and writes no file until `set()`; (b) a valid JSON file
   round-trips; (c) a file containing non-JSON bytes leaves the original bytes preserved in a
   `*.corrupt-*` sibling, returns an empty store, and a subsequent `set()` writes a fresh valid file —
   the original bytes are **not** in the new file. PASS = test green.
5. **No regression / no surface change:** `npm test` exit 0 (full suite, baseline 1136 pass/0 fail/1
   skipped, verified this session), `npm run typecheck` exit 0, `npm run eval` exit 0 (5/5), and
   `test/kernel-surface.test.ts` green including the `< 2200` line assertion (final ≈ 2199, `< 2200`,
   by D4) and the unchanged-export pins.

## 8. Risks and Rollback

- **Risk:** FRESH-1's `signal.aborted` check swallows a *genuine* error that coincidentally races with
  a user `stop()`. **Mitigation:** this only happens when the user actually requested cancellation, so
  reporting `reason:"stop"` is defensible; the genuine-error path (no abort) is unchanged and pinned by
  AC#2. **Rollback:** revert the catch to the 3-line original.
- **Risk:** FRESH-2 masks a real misconfiguration by clamping silently. **Mitigation:** `<= 0` is never
  a valid concurrency, so the clamp can only improve on a crash; the value is rarely set. **Rollback:**
  revert the one-line constructor change.
- **Risk:** FRESH-4's `existsSync`/`readFileSync` TOCTOU, or a rename that fails. **Mitigation:** the
  inner best-effort `try` and the absent-file fast path both degrade to today's `{}` behavior — never a
  new throw. **Rollback:** revert `read()` to the original 7-line catch-all.
- **Risk:** the three diffs together breach the kernel line ceiling (real headroom is **1 line** at
  2198/2200). **Mitigation:** D4 — the +5 raw additions are offset by compressing the `run()`
  abort-handling comment (`agent.ts:238-243`, which FRESH-1 updates anyway) to net ≈ +1 (final ≈ 2199);
  `flush()` is left untouched per §3. `test/kernel-surface.test.ts` is re-run after each kernel edit,
  and the L2 plan carries the exact byte accounting **before** any edit. **Rollback:** the ceiling test
  fails loudly before merge; if the offset cannot be found, escalate (do not raise the ceiling
  silently).
- **Overall rollback:** each deliverable is an independent, self-contained diff in one method; any one
  can be reverted without affecting the others.
