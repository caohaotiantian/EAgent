# Decision — validated closures for deferred items that shouldn't/can't be built

**Slug:** `2026-07-01-deferred-closures` · **Tier:** None-equivalent (a won't-build decision record, one
fresh-reviewer confirmation — no code change). Under the "finish every deferred item" directive, these
are the items where **building the deliverable would degrade the project or is inert under the
constraints**, so the honest completion is a definitive, fresh-eyes-validated *won't-build* with the
concrete rationale + what a deployment does instead. Branch: `chore/finish-followups-4`.

> A fresh reviewer must confirm each rationale (that the item genuinely can't be built into a useful,
> non-degrading, offline-testable slice) — or flag it as buildable, in which case it is built instead.

## RW6c-2 — dir-scoped macOS `sandbox-exec` write profile — WON'T BUILD (regression risk > value)

`codeact`'s macOS write profile allows `(subpath "$root") (subpath "/private/tmp") (subpath
"/private/var/folders")` (`lib/sandbox.ts:108-110`). Narrowing it to just the per-call dir would risk a
**fail-closed `ENOENT`**: interpreters (python/node) write caches/temp under `/private/var/folders`
(the default `TMPDIR`), so a `dir`-only profile can break a legitimate snippet — a regression the
**string-only offline test cannot catch** (no real `sandbox-exec` in CI). The load-bearing guarantee
(no `$HOME`/project writes) **already holds**; temp-wide write is ephemeral and low-risk. Net: marginal
security gain, real fail-closed regression risk, uncatchable offline. **A deployment that needs a
tighter profile sets a narrower `TMPDIR` and uses `bwrap`/`firejail` (already `dir`-scoped).**

## RW6b-1 — consolidate flow-guard data-taint into provenance — WON'T BUILD (degrades a default-on guard)

`flow-guard` (default **ON**, regex/pattern → egress, message-pinned, clears on `/clear`) and
`provenance` (default **OFF**, source/verbatim-segment → sink, closure-Set, doesn't clear) occupy
**distinct, both-working** taint axes. Merging them is a **pure refactor with no functional gain** that
would silently change *when each fires* and **risks regressing a default-on security guard**. The
register calls it "a simplification opportunity, not a gap." Building it trades real regression risk for
zero user-visible benefit — the opposite of Simplicity First. **No change; the three guards remain
complementary.**

## DEFERRED-5 — evals statistical pass@k CIs — WON'T BUILD (value unrealizable offline)

pass@k needs **k stochastic samples** per scenario to estimate a pass rate. The offline eval harness
runs the **deterministic** `MockProvider`, so every one of k samples is **identical** → pass@k ≡ pass@1
and the confidence interval is degenerate (0 variance). The machinery (run k times, compute the
statistic) is buildable but **inert under the offline constraint** — it would ship a metric that is
structurally meaningless in CI. **A deployment wanting real pass@k runs the eval harness against a live
stochastic provider (an ops/CI-with-keys task, not the offline gate).** The thin assertions+scorecard
slice (DEFERRED #5's own framing) remains the offline deliverable.

## Register + acceptance

Each item's `DEFERRED-FOLLOWUPS.md` row is annotated **CLOSED (won't-build) 2026-07-01** with a
one-line rationale + the deployment alternative. No code changes; `npm test`/`typecheck`/`eval` remain
green (nothing touched). Acceptance = the fresh-reviewer verdict confirming each closure is correct (no
useful non-degrading offline-buildable slice exists) — or naming one, which reroutes that item to a
build.

## Closure

**Closed** 2026-07-01. A fresh adversarial reviewer (whose brief was to *find* a buildable safe slice)
**CONFIRMED all three** won't-build decisions, finding no useful, non-degrading, offline-testable slice:
- **RW6c-2** — every narrowing risks an offline-uncatchable fail-closed EPERM/ENOENT: codeact spawns the
  interpreter with a *scrubbed* env (`HOME=os.tmpdir()` under `/private/var/folders`, `TMPDIR` unset →
  Node's `os.tmpdir()`=`/tmp`), so dropping *either* temp subpath breaks a legit snippet; the only
  string-testable variant is a trap knob. Both temp subpaths are *more* load-bearing than first stated.
- **RW6b-1** — flow-guard (read-sensitive→egress, pattern, default-ON, clears) and provenance
  (fetch-foreign→sink, verbatim-segment, default-OFF, doesn't clear) are genuinely dual axes; a merge
  adds no capability and risks regressing a default-ON guard. The RW3-1 child-gap is already closed by
  W9.1 (`flow-guard.ts:168-169` reads the acting transcript).
- **DEFERRED-5** — MockProvider is deterministic (`mock.ts:114-119`; `runEvalDir` runs each scenario
  once), so pass@k ≡ pass@1 offline; a varied-mock version would measure a hand-authored distribution,
  not agent reliability. Real pass@k needs a live stochastic provider (an ops/CI-with-keys task).

No code changed; the suite stays green. The register rows are annotated CLOSED (won't-build).
