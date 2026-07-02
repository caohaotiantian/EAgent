# EAgent — Session Handoff & Project Status

**Start here for a fresh session.** This is the orientation + status doc. Authoritative detail lives in
the files this doc points to; where they disagree, *they* win (this doc drifts, they don't).

_Snapshot: trunk `init` @ `64eb15b` · 1195 tests pass / 0 fail / 1 skip · kernel 2198/2200 · `npm run
eval` 5/5 · typecheck 0 · zero runtime deps except `jiti`._

---

## 1. What EAgent is (the goal of this system)

EAgent is a **minimalist AI-agent kernel**: a tiny, stable, observable core plus an Emacs-grade
extension surface. The central bet — stated in `CLAUDE.md` and enforced in code — is that **a small,
malleable core beats a big one**: new behavior is *always* an extension, never a fork of the core.

- **Seven kernel primitives, nothing more** (`src/kernel/`): hook bus (`hooks.ts`), tool registry
  (`registry.ts`), provider abstraction (`types.ts` interface), agent loop (`agent.ts`), capability
  layer (`capabilities.ts`), extension host (`extension.ts`), command registry (`commands.ts`). The
  whole core is held under a **hard 2200-line ceiling** (`test/kernel-surface.test.ts`, metric =
  `split("\n").length` summed over `src/kernel/*.ts`). It sits at **2198 — one to two lines of slack**.
  That scarcity is deliberate: it forces every new capability to be an extension.
- **Everything else is an extension** — even the four "built-in" tools (`read`/`write`/`edit`/`bash`)
  live in `src/extensions/core-tools.ts`. 58 extensions ship in `BUILTIN_EXTENSIONS` (`src/host.ts`);
  each is a single capability-gated file with offline tests, most with an `EAGENT_<NAME>=off` kill
  switch, most **off by default**.
- **Security vocabulary = capabilities** (`fs:read`, `shell:exec`, `net:fetch`, `agent:spawn`, …): a
  privileged tool declares `capabilities: [...]` and the dispatcher enforces them before `execute`. See
  `SECURITY.md`.
- **Invariants that shape every change:** ZERO runtime dependencies except `jiti` (providers use global
  `fetch`, no SDKs); ALL tests run **offline** against a deterministic scriptable `MockProvider`
  (`src/providers/mock.ts`) — no network, no API key; ESM + NodeNext (always `.js` import specifiers,
  even for `.ts`); strict TypeScript.

**Read to understand the design:** `CLAUDE.md` (orientation + house rules), `README.md` (the extension
table), `docs/EXTENSIONS.md` (how to write one), `docs/RESEARCH-agent-kernel-design.md` +
`docs/REDESIGN-NOTES.md` (the "why").

---

## 2. How work is done here (the process — important)

**Non-negotiable convention (from `CLAUDE.md`): NO Claude/AI attribution in commits or PRs.** No
`Co-Authored-By: Claude`, no `Claude-Session:` trailers, no `claude.ai` links, no `claude/`-prefixed
branch names in merge subjects. Commits land under the human author only. This overrides any default
harness footer.

**Every non-trivial change goes through the `three-loop-workflow` skill** (L1 design → L2 impl → L3
dev/review/accept → F end-to-end review), fresh-reviewer-gated at each loop, with RED/mutation-verified
tests. Tiers: **Full** (load-bearing files, breaking changes, migrations, a >1-option or magic-number
decision, or >3 non-load-bearing files) vs **Light** (≤3 files, additive, no decision — a 4-field brief
+ one fresh review). The recent work used the `l3-phase.js` Workflow orchestrator for L3 (dev→review→
accept on a dev branch; the main agent then merges ff-only + re-runs the gates + does the F closeout).

**Gates to run before claiming done:** `npm test` (0 fail), `npm run typecheck` (0), `npm run eval`
(5/5), and for any kernel touch `node --import tsx --test test/kernel-surface.test.ts` (the `<2200`
ceiling + the export-surface pin). Confirm `src/kernel/` is untouched unless the change is deliberately a
kernel change.

**PR cadence used:** accumulate a coherent batch on a `chore/<slug>` branch, PR to `init`, `gh pr merge
--auto --merge`. `init` is the default/trunk branch — branch before committing.

---

## 3. Progress — what has been built (chronological)

The full per-wave record is `docs/ROADMAP.md`; the authoritative deferred/built status is the **Closure
ledger** at the top of `docs/DEFERRED-FOLLOWUPS.md`. Summary of the completed programs (all merged to
`init`):

1. **Re-design Waves 1–9** (PRs #17–#18) — a first-principles rebuild to the 7-primitive core + the
   extension surface, then a 6-lens production-readiness audit closed 20 gaps (Wave 9). Introduced the
   `currentActingAgent()` `AsyncLocalStorage` seam so soft-guards act on the acting sub-agent.
2. **Post-Wave-9 follow-ons** (PRs #19–#23) — a real-backend `sandbox-linux` bwrap CI job; a deferred-
   cleanup batch; Tree-of-Thought (`tree_search`) + Graph-of-Thought (`graph_search`) on the fork spine;
   full OTLP metrics + logs.
3. **Finish-deferred + KR-1** (PRs #24–#25) — kernel defensive-robustness (a mid-stream abort now reports
   `reason:"stop"` cleanly; `maxConcurrency` clamp; corrupt-store preserve-aside), a `checkpoint` kill
   switch, an OTel duration histogram, and the server abort-snapshot guard.
4. **Finish-followups — register driven to EXHAUSTION** (PRs #26–#28) — every remaining
   `DEFERRED-FOLLOWUPS` item was **built** (optional semantic/embedding `memory` recall; risk-guard
   per-value decode; memory auto-promotion; `graph_search` refine-to-convergence; OTel W3C `traceparent`
   propagation) or **adversarially-validated-closed** (17 won't-builds with deployment alternatives).
   A closure ledger was added as authoritative status.
5. **Audit-gaps program (2026-07-02)** (PRs #29–#31) — a register-**blind** production-readiness audit
   found **13 NEW gaps**; all resolved across 6 three-loop waves:
   - **Server request-lifecycle** (SRV-1/2/3/5/6): class-wide `res.on('error')`, `sendJson` headers-sent
     guard + restore-inside-try, **LRU `sessions` cap** (`EAGENT_MAX_SESSIONS`, default 1000), dispose-
     on-error, idempotent shutdown.
   - **Security guards** (GUARD-1/2/3): `secret-guard`/`flow-guard` arg scans depth-bounded
     (`MAX_SCAN_DEPTH=8`); `risk-guard` classifier `AbortSignal.timeout` (`EAGENT_RISK_GUARD_TIMEOUT_MS`).
   - **SSE OOM guard** (SRV-4): `parseSSE` caps an un-terminated event (`EAGENT_MAX_SSE_EVENT_BYTES`,
     16 MiB).
   - **Embedder wire test** (TEST-1): `resolveEmbedder` `fetch`-stub coverage.
   - **Kernel capability-prompt dedup** (KERN-1): an `#pending` in-flight memo so concurrent callers share
     one confirm — a user-directed BUILD (over an assessment's close recommendation), **comment-golfed
     losslessly** to hold `<2200` (2199→2198).

---

## 4. Open / deferred work (a fresh session's task list)

A whole-project inventory (2026-07-02) found **almost everything is deferred-by-design and tracked**;
there is very little genuinely-unfinished work. Ranked:

### Needs a decision or finishing
_All three ranked items below are now **RESOLVED** (2026-07-02, branch `chore/finish-open-items`, Full
three-loop each, F-review pass). Nothing in this subsection remains open._
- **① [RESOLVED 2026-07-02] `checkpoint` auto-snapshot now runs async, serialized git.** Was:
  synchronous `execFileSync` on every mutating call, stalling the shared HTTP host's event loop. Now:
  the shared `git()` helper is async (`promisify(execFile)`), and every snapshot — the auto-hook **and**
  the manual `/checkpoint` command — is serialized through one per-activation promise-chain queue so
  concurrent tool-call waves cannot race on checkpoint ids/refs; snapshot-before-mutation ordering is
  preserved (the async hook awaits its snapshot before the tool runs). Was chosen (over ratify-sync) per
  a user decision. `docs/design/2026-07-02-checkpoint-async-git.md`.
- **② [DONE — safe-cleanup pass] Stale docs fixed:** the `reasoning-search.ts` header docstring now
  states `tree_search`/`graph_search` ship; `edit-match.ts` was **moved into `lib/`** (making
  `CLAUDE.md:70`'s "helpers in `lib/`" accurate — no CLAUDE.md edit needed); the register drift was fixed
  (SRV-4 cap ref → `http.ts:16-21`, RW3-3 "4"→"5"); and the env-conditional `codeact.test.ts:121`
  python3-skip is now recorded as a known test-coverage caveat in `DEFERRED-FOLLOWUPS.md`.
- **③ [RESOLVED 2026-07-02] SRV-4b — MCP transport reads now capped.** `readCapped` was relocated to
  `src/extensions/lib/read-capped.ts` (shared helper); the HTTP transport (`#readResponse`) bounds both
  the SSE and JSON reads via `maxMcpReadBytes()` (`EAGENT_MAX_MCP_READ_BYTES`, default 16 MiB) and throws
  on overflow; the stdio transport uses a byte-bounded `createBoundedLineReader` (discard-to-newline,
  whole-line UTF-8 decode) in place of the unbounded `createInterface`, so a hostile server cannot OOM
  the host. `docs/design/2026-07-02-mcp-read-caps.md`.

### Tracked deferrals & by-design cuts (the honest "what's not there")
All intentional, each with a rationale + alternative in `DEFERRED-FOLLOWUPS.md` / a design-doc closure:
- **Kernel-headroom won't-builds** (spend the scarce kernel line for no consumer): `Agent.fork`,
  `spawnChild`, event `agentId`/`depth`, `beforeDispatch` inject/share, fallback-routing→`onProviderError`,
  per-session server isolation. Each has an extension-compose alternative.
- **Feature cuts:** secret-guard env-rewrite, N-tier routing, MCP subscriptions/templates, `.skill`
  signing, GoT operations-DSL, semantic-memory hybrid-fusion + embed-on-write caching, delta checkpoints.
- **Needs external infra:** a real container/microVM sandbox backend (RW6c-1 — **still an open tracked
  row**; the fail-closed OS-launcher fallback ships) and a live OTLP-collector smoke.
- **Accepted server residuals:** no global `uncaughtException` backstop (deliberate); CLI interactive-REPL
  SIGTERM gap; SRV-5 pre-return orphan window; `void shutdown` unhandled-rejection edge; traceparent
  cross-host-redirect (random ids only, inert by default).
- **~14 dormant-by-default opt-ins** (otel propagation, semantic memory, auto-promotion, risk-guard,
  provenance, sandbox-tiers, …) — present but inert until configured.

### Test-coverage caveats
Real-backend confinement + real self-improve eval run only in the `sandbox-linux` CI job (every push).
The 1 suite skip is `self-improve-integration.test.ts`. Live-endpoint smokes (embeddings, OTLP) are
un-offline-testable by design. For the SRV-4b MCP read caps, only a live hostile-server smoke is
un-offline-testable — the cap-enforcement logic itself is offline-tested (`test/mcp.test.ts`,
`test/mcp-http.test.ts`).

---

## 5. Suggested next steps for a fresh session

1. **If asked to keep hardening:** pick up **① async checkpoint git** (real value) then **③ SRV-4b**
   (MCP read caps — reuse `readCapped`). Both through the three-loop.
2. **Quick doc hygiene** — DONE in the 2026-07-02 safe-cleanup pass (see item ② above). Nothing left here.
3. **If asked for new capability:** it is almost certainly an **extension** (see `docs/EXTENSIONS.md`),
   not a kernel change — the kernel has ~1 line of slack, and adding to it requires golfing or an
   explicit user decision (as KERN-1 was).
4. **Before starting:** read `CLAUDE.md`, skim the `DEFERRED-FOLLOWUPS.md` Closure ledger + the
   2026-07-02 audit-gaps table, and run the gates (`npm test`, `npm run typecheck`, `npm run eval`) to
   confirm the baseline is green.

---

## 6. Where to look (authoritative sources)

| For… | Read |
|---|---|
| Project orientation + house rules | `CLAUDE.md` |
| The extension set + one-liners | `README.md` (table), `src/host.ts` (`BUILTIN_EXTENSIONS`) |
| Deferred/built status (authoritative) | `docs/DEFERRED-FOLLOWUPS.md` (top Closure ledger + audit-gaps table) |
| Per-wave history | `docs/ROADMAP.md` |
| Design/impl of a specific change | `docs/design/<date>-<slug>.md`, `docs/implementation/<date>-<slug>.md` |
| How to write an extension | `docs/EXTENSIONS.md` |
| Security model | `SECURITY.md` |
| The dev process | the `three-loop-workflow` skill |
| Commands | `npm test` / `npm run typecheck` / `npm run build` / `npm run dev` (REPL) / `npm run serve` (HTTP) / `npm run eval` |

**One gotcha worth knowing:** the kernel line budget is measured by `split("\n").length` (= 2199 before
KERN-1, now 2198), **not** `wc -l` (2187) — don't conflate them when reasoning about headroom. Also, on
macOS, `grep` silently skips EAgent source files containing non-ASCII glyphs (`→`/`σ`/`≥`); use `grep -a`
or the Read tool for audits.
