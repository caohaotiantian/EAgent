# Design — self-improve hardening (B1 blocker + robustness)

**Slug:** `2026-06-29-self-improve-hardening` · **Wave:** 9 (subsystem W9.2 of 6) · **Mode:** Full
**Source:** [`docs/audits/2026-06-29-production-readiness-audit.md`](../audits/2026-06-29-production-readiness-audit.md) §2 (B1), §3 (self-improve robustness), RW8b-2.

## 1. Background and the gap (code as truth)

`self-improve` (off by default) is sound in posture but the audit found one **blocker** and four robustness
gaps, all in `src/extensions/self-improve.ts` + `src/self-improve-eval.ts`:

- **B1 (blocker) — the human-review gate shows the reviewer nothing.** `adopt_improvement` surfaces the
  candidate source via `ctx.progress(...)` (`self-improve.ts:326`), but `progress` is wired to
  `logger.debug` (`agent.ts:525`), which **both front ends silence** (`cli.ts:146` `debug:()=>{}`;
  the HTTP server never routes debug to the elicit channel). The very next line asks
  `ui.ask("Adopt …? Review the source above…")` (`:327-329`) and a `^y` answer calls `e.loadExtension`
  (`:343`) → arbitrary in-process code with the full `ExtensionAPI`. So the *documented* safety boundary
  (human source review) renders **nothing**, and the prompt actively misleads. (Fail-closed bits hold:
  opt-in; `ui.ask` null → no adopt.)
- **G-execSync — the evaluator blocks the event loop ~2×120s.** `runScored` uses synchronous `execSync`
  (`self-improve.ts:113`, timeout 120s) called twice by `realEvaluate` (`:147,:148`); during the freeze the
  loop, `/health`, abort, and disconnect-driven `stop()` all stall. The inline "must not block the agent"
  comment is wrong.
- **G-path — `realEvaluate` is dev-tree-only.** `runScored` builds a **cwd-relative** `node --import tsx
  src/self-improve-eval.ts` (`self-improve.ts:111`, `cwd=process.cwd()` `:130`), so it only resolves from
  the repo root under tsx; from a built `dist` or any other cwd it fails.
- **RW8b-2 — failed adopt-load leaves an orphan live.** `renameSync(staged→live)` (`:330`) precedes
  `e.loadExtension` (`:336`); the catch (`:337-342`) returns `fail` without reverting the rename or marking
  the record, and `liveExtensionsDir()` is the host auto-discover dir (`host.ts:266`), so a transient load
  failure auto-loads the orphan next restart, and retry breaks (the staged file is gone).
- **G-cap — `evaluate_candidate` declares no capability** (`self-improve.ts:251-288`) while
  `propose`/`adopt` declare `self:extend`; yet it spawns a subprocess that **runs** the staged candidate
  (code execution) — no ask-prompt, no audit entry at the first code-execution point.

The production evaluator path (`realEvaluate`/`runScored`/`hashFixtures`/tamper-diff) is **entirely
unexercised offline** (every test injects a stub via `setEvaluator`), so these ship untested.

## 2. Deliverables

- [ ] **D1 (B1 blocker) — render the source where the human actually reads it.** In `adopt_improvement`,
  fold the candidate **source + advisory delta into the `ui.ask` prompt string itself** (the prompt is the
  one channel guaranteed to reach the human), e.g. `ui.ask("Adopt \"slug\"? Review the FULL source below…\n\n---\n<source>\n---\nAdvisory: <delta>\n\nLoads in-process with full authority. Type 'yes' to adopt:")`.
  Also emit the source to `ctx.log.warn` (surfaces on the CLI, `cli.ts:147`) for the record. Drop the
  silent `ctx.progress` for the source. Keep the fail-closed `null/^y` semantics. (Use `ctx.ui.ask` — the
  tool's own context UI — not `e.agent.ui`.)
- [ ] **D2 (execSync→async, abortable)** — make `runScored` use **async `exec` (promisified) or
  `spawn(…, { shell: true })`** (NOT `execFile` — `wrapCommand` produces a full shell *string*, not a
  binary+args; both `exec`/`spawn` accept `{ signal, timeout }`), awaited via a Promise with a kill-on-
  timeout + abort wired to **both** the 120s timeout and `ctx.signal`, so the agent loop and `stop()` stay
  live during the eval. **Thread the signal through:** widen the `Evaluator` type (`self-improve.ts:66`) to
  `(candidatePath: string, signal?: AbortSignal) => Promise<EvalResult>` and pass `ctx.signal` at the call
  site (`evaluate_candidate`'s `await evaluator(…, ctx.signal)`, ~`:279`). `realEvaluate` stays `async` and
  now actually yields. Honest comment.
- [ ] **D3 (robust runner path)** — resolve the `self-improve-eval.ts` path from **`import.meta.url`** (the
  module's own location) rather than `cwd`, so the evaluator works regardless of the process cwd. (Keep the
  `provider:"mock"` + staging-root + sandbox wrapping unchanged.)
- [ ] **D4 (RW8b-2 rollback)** — on a `loadExtension` failure **after** the staged→live rename, **move the
  file back to staging** (so it is not auto-discovered next restart and the record stays `staged`/retryable).
  The reviewed-and-approved source is preserved for retry. (A status-flag-only alternative does **not** work:
  host discovery scans the live dir **by filename** — `extension.ts:137-149` → `listExtensionFiles` — and
  never consults self-improve's store, so the orphan would still auto-load. Move-back is the only fix.)
- [ ] **D5 (capability on evaluate)** — declare `capabilities: ["code:exec"]` on `evaluate_candidate` (it
  spawns a subprocess that runs candidate code), so the first code-execution point is capability-gated +
  audited like `propose`/`adopt`.
- [ ] **D6 (offline coverage for the previously-untested glue)** — add **pure/unit** tests for the parts of
  the production path that are CPU-only (no real subprocess): `runScored`'s command-string assembly + the
  `eval: X/Y passed` scorecard regex (feed it a captured stdout sample), `hashFixtures` determinism, the
  tamper pre/post diff. The real spawned subprocess stays integration-only (RW8b-1, separate), but the glue
  it depends on gets pinned. **Test seams to add (all additive extension-level exports — NOT kernel, so
  `kernel-surface` is unaffected):** export `runScored`, `hashFixtures`, and the scorecard parse (currently
  module-private / inline at the regex), and add a **spawn-injection seam** (a module-level setter mirroring
  the existing `setEvaluator` at `:173`) so AC-D2 can inject a fake spawn that never resolves + assert the
  aborted-signal path returns promptly. Enumerated here so L2 implements them deliberately.

## 3. Out of scope

The full real-subprocess `realEvaluate` end-to-end (a real sandboxed `node --import tsx` run) stays
integration-only — RW8b-1, deferred. The by-design posture (trust-on-human-review, advisory eval, fail-open
sandbox default) is unchanged — D1 makes the *human-review* gate actually functional, which is the point.

## 4. Key Design Decisions

### KDD-1 — Put the source in the `ui.ask` prompt, not a side channel
*Problem:* the reviewer must see the source before consenting; `ctx.progress` is silenced and `ctx.log`/
notify are easy to miss/scroll past. *Options:* (a) route source to `ctx.log.warn` + keep the generic
prompt; (b) fold the source **into the prompt string** the human answers (+ `log.warn` for the record).
*Choice:* **(b)** — the prompt is rendered synchronously at the decision point and cannot be missed; a stub
`ui.ask` in tests can assert the prompt contains the source (AC-B1). *Rejected:* (a) alone — `warn` can
scroll off; the prompt would still say "review above" with nothing guaranteed there.

### KDD-2 — `import.meta.url` for the runner path; async spawn for the eval
The runner is a sibling module, so its path is a stable function of `import.meta.url`, not the volatile
`cwd` — this also fixes the dist-tree breakage. The eval is I/O-bound and long, so it must be a non-blocking
async spawn with abort wiring; `execSync` was the wrong primitive for a path that runs inside the agent loop.

### KDD-3 — Gate `evaluate` at `code:exec`, not `self:extend`
`evaluate` does not extend the agent (no live load) — it *executes* candidate code in a subprocess, so
`code:exec` is the honest capability (matches `codeact`), giving the operator an ask-prompt + audit entry at
the first execution point. `propose`/`adopt` keep `self:extend` (they stage/load extension code).

## 5. Acceptance Criteria (measurable, offline)

- **AC-1** typecheck 0. **AC-2** `npm test` 0. **No kernel change.**
- **AC-B1 (blocker fixed)** With a stub `ui.ask` that **captures the prompt string**, `adopt_improvement`
  on a staged candidate passes a prompt that **contains the candidate source** (and the advisory delta);
  a `yes` adopts (tool appears), a `no`/null does not (fail-closed). Pre-fix this test fails (prompt lacks
  the source).
- **AC-D2 (non-blocking/abortable)** `runScored`/`realEvaluate` are async and honor an aborted `ctx.signal`
  (unit: an injected fake spawn that never resolves + an aborted signal → `realEvaluate` rejects/returns
  promptly, not after 120s). (Pure-ish: stub the spawn boundary; no real subprocess.)
- **AC-D3 (path)** the resolved runner path is derived from `import.meta.url` and ends in
  `self-improve-eval.ts` regardless of `process.cwd()` (unit).
- **AC-D4 (rollback)** an injected `loadExtension` that throws → after `adopt_improvement`, the file is back
  in staging (not in the live dir), `rec.status !== "adopted"`, and a second attempt can still find the
  staged file.
- **AC-D5 (capability)** `evaluate_candidate.capabilities` includes `code:exec`; a deny policy blocks it.
- **AC-D6 (glue coverage)** unit tests pin the scorecard regex (sample stdout → counts), `hashFixtures`
  determinism + change-detection, and the command-string shape.

## 6. Risks and Rollback

- **R1 — multi-line prompt rendering.** CLI `ui.ask` uses `rl.question`, which prints the full (multi-line)
  prompt then waits — so a large source renders fine; HTTP elicit passes the prompt through. *Residual:* a
  very large candidate makes a long prompt — acceptable for a human-gated, opt-in adopt; could truncate with
  a "full source at <path>" pointer if needed (noted, not done).
- **R2 — async spawn abort semantics.** *Mitigation:* AC-D2 pins abort; the timeout + signal both kill.
- **R3 — D4 move-back races a concurrent discovery.** *Mitigation:* adopt is human-gated + single-flight;
  the move-back is synchronous within the failed-adopt handler.
- *Rollback:* each deliverable is an independent, additive edit to `self-improve.ts`/`self-improve-eval.ts`;
  revert any one without affecting the others. No kernel change.
