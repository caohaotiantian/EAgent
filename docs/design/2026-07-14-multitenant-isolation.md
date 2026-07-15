# Design — Full concurrent in-process multi-tenant isolation (HTTP server)

Slug: `2026-07-14-multitenant-isolation`
Status: **closed** (2026-07-15)
Closing-commit: `af073fa`
Closed-on: 2026-07-15
Supersedes: `docs/design/2026-07-10-session-isolation.md` (closed won't-build; its getter/root-detection
mechanism is carried forward and its commingling enumeration is re-validated + expanded here).
Deferred: finding — a detached `launch_job`'s frames route by session **root**, so a still-running
background job's events can surface in a **later same-session** `/run` stream (within-session, never
cross-tenant; strictly narrower than the pre-cycle single-Agent behavior). Proper fix = per-request
stream routing; recorded as a known limitation in §10.

Built across 4 fresh-reviewer-gated L3 phases (A mechanism, B the 7 security guards, C correctness
state + observability, D concurrency). L1 caught + fixed 6 severe design flaws pre-code (both linchpins —
ALS streaming routing, `currentRootAgent()` inheritance — empirically validated). A whole-cycle
adversarial audit (6 dimensions × 3-lens refute-by-default verify) confirmed **zero severe** findings
and drove two general completeness fixes (compact re-entrancy guard + citations `lastRun` → per-root,
`af073fa`).

## 1. Background and Purpose

The HTTP server (`src/server.ts`) runs every session's turn on **one shared `Agent`**
(`createAgentHost` once at startup; `session_start` emitted once, `server.ts:135`). Per-session
`AgentState` (transcript/usage/model) is isolated by a snapshot pool (`Map<session, AgentState>`,
`server.ts:156`; restore→run→snapshot per turn), but **extension state accumulated in the single
activation commingles across sessions**, and a **single-flight busy lock** (`server.ts:157,291-300`)
serializes all turns — so the server is neither state-isolated nor concurrent across tenants.

**Reopened decision (2026-07-14):** build **full concurrent in-process multi-tenant isolation** — each
session runs on its own `Agent`, its extension state is per-session, and **turns from different sessions
run concurrently** without event cross-talk. (The 2026-07-10 review deferred this in favor of a
process-boundary posture; the user has now chosen to build it.)

**Why it is security-critical and all-or-nothing.** A re-validation (2026-07-14) found extension state
commingling across HTTP sessions: **14 extensions are converted** (7 security-critical + 7 for
correctness, §2/D4/D5), and a handful more commingle but are **left shared by design** (§5 — OTel
cumulative metrics, `playbook`, `sandbox-tiers` probe, `headless-flags`, `packages`, `planmode`). For the
**7 security-critical** among the converted, a guard decision from session A leaks into B: a server that
isolates cost/goal but leaves `write-guard`'s seen-set or
`provenance`'s untrusted-taint commingling *looks* isolated while leaking security decisions across
tenants — **strictly worse** than an honestly-documented single-tenant server. Every security-critical
commingle must be closed, or the feature is not shipped.

## 2. The commingling enumeration (re-validated 2026-07-14; the Phase-scope crux)

The discriminator: on the shared-Agent server `agent_start` fires **per `/run`** but `session_start`
fires **once at startup** (`server.ts:135`). State reset on `agent_start` does **not** commingle; state
reset only on `session_start` — or **never** — **does**. Verified against the 63-entry
`BUILTIN_EXTENSIONS` (`host.ts:98-162`).

**Security-critical (7) — a guard decision leaks A→B; MUST be isolated:**

| Extension | State | Reset |
| --- | --- | --- |
| `write-guard` | `seen` Set of read/written abs paths (`:66`) — B overwrites A's file without the prompt | session_start-only |
| `flow-guard` | `tainted` source-caps + `pending` Map (`:127/:136`) — A's exfil taint gates B's egress | session_start-only |
| `provenance` | `untrusted` Set of foreign-content segments (`:87`) — A's sink-gate taint gates B | **never** |
| `bash-policy` | `approved` command families (`:594`) — A's approval skips B's confirm prompt (**not reachable on today's server** — `serverUI.confirm` is hardcoded `false`, `server.ts:111`, so `approved` never grows; converted defensively for a future interactive server) | session_start-only |
| `skills-hardening` | `activeAllowlists` Map (`:242`) — A's scoped-skill allowlist governs B | session_start-only |
| `subagent-jobs` | `jobs` registry (`:75`) — B can `job_status`/`wait_job`/`cancel_job` A's jobs (`:245/276/315`) | **never** |
| `budget-cap` | `sessionUsd` enforcement gate (`:188`) — STALE from a prior session across a run's first tool calls | **never** |

**Non-security (isolate for correctness) (7):** session-scoped (`currentRootAgent()`-keyed): `cost`
(sessionUsd/perModel/anomaly window), `goal` (objective/criteria), `todo` (items), `drift-probe`
(turn/probe counters), `handoff` (resume latch); per-run-tree (`currentRootAgent()`-keyed, `agent_start`
reset kept): `limits` (per-turn tool/token bound), `fallback-routing` (per-run circuit). (`otel-exporter`
metrics stay shared — KDD6; its spans are already per-`Agent`. `playbook` stays shared — intentional
global.) This is the authoritative Phase-C convert set; it matches D5.

**Left shared, documented (not converted):**
- `otel-exporter` metric counters — OTel metrics are **process-cumulative by design** (KDD6). The
  per-`Agent` `traces` WeakMap already isolates spans.
- `sandbox-tiers` (`warned`/`probed`) — cosmetic warn-once + host-global backend probe; **enforcement is
  read fresh** from `e.config` per call → no security decision commingles.
- `headless-flags` (`cached`) — a host TTY/env property, identical for every session (inert commingle).
- `planmode` — a shared server-wide store flag, read fresh (fail-safe); server-wide plan mode is intended.
- `packages` — loaded package code is **process-global by nature** (`pkg:install` runs in-process);
  per-session package sets are a separate follow-up.
- `playbook` — an intentionally-global knowledge base (like `memory`), shared by design.
- `integrity` — advisory tool-description baseline in shared store; re-baselines on the one
  `session_start`; **does not commingle** a decision.
- `checkpoint`/`session`(disk)/`journal` — process-global (one workspace, disk by id, one file); a
  separate follow-up.

## 3. The mechanism (validated)

### 3a. Per-session `Agent` pool (replaces the AgentState snapshot pool)
Each session gets its **own `Agent`** sharing the host's `hooks`/`tools`/`providers`/`capabilities`/
`ui`/`logger` (readonly, extensions registered against them) with **fresh** `model`/`systemPrompt`/
`thinking`/`maxTurns`/`provider`/`maxConcurrency` from host defaults (`agent.ts` ctor separates these).
The pool becomes `Map<session, Agent>` (LRU-capped by `EAGENT_MAX_SESSIONS`); each Agent holds its own
transcript/usage natively, collapsing restore→run→snapshot to `agent.run(input)`. **The `danglingUser`
guard is RETAINED** (not removed): `agent.run()` pushes the user message unconditionally (`agent.ts:225`),
and an abort during the first stream breaks with `reason="stop"` before any assistant push — leaving a
trailing bare user message. Today's snapshot pool discards it by not snapshotting that state
(`server.ts:401-402`); a **persistent** Agent instead *bakes it in*, so the next `/run` would append a
second consecutive user message (rejected by real alternating-role providers; masked by MockProvider). D2
therefore **pops/refuses a trailing user message left by an aborted run** on the per-session Agent before
the next turn — the persistence makes this rollback more necessary, not less.

### 3b. Two keying scopes: session-root vs acting-agent (the L1-round-1 correction)
A "session" is a **run tree**: the session's root `Agent` plus any sub-agents it forks. Extension state
splits into two scopes, and keying MUST match the scope or it either leaks across sessions or breaks
within a session (the S2 finding):

- **Session-scoped state** (a decision that spans the whole session tree, parent + forks, and must be
  isolated *between* sessions) → `WeakMap<RootAgent, …>` keyed on **`currentRootAgent()`** (3c). This is
  the correct home for every **security guard** — `flow-guard`'s `tainted` and `provenance`'s `untrusted`
  *deliberately* accumulate a fork's activity to gate the fork's sinks (the documented cross-agent
  confused-deputy exfil catch, `flow-guard.ts:206-207`, `provenance.ts:26-28`); keying them on the acting
  (child) agent would silently drop that catch. Same for `write-guard`'s `seen`, `bash-policy`'s
  `approved`, `skills-hardening`'s `activeAllowlists`, `subagent-jobs`'s `jobs`, `budget-cap`'s
  `sessionUsd`, and the session-level accounting/UX (`cost` session totals, `goal`, `todo`, `drift-probe`).
- **Per-run-tree state** (accumulates across the tree within a turn, cleared each top-level `agent_start`)
  → `WeakMap<RootAgent, …>` keyed on **`currentRootAgent()`**, **keeping the `agent_start` reset** (which
  fires only for the session root — `childScope` suppresses it for forks — so it zeroes the *root's* entry
  each turn while forks aggregate onto it). `limits` (`toolCallsThisRun`/`tokensThisRun`) belongs here:
  today `childScope` suppresses a fork's `agent_start`, so a fork's calls **aggregate onto the tree-wide
  per-turn bound** (`limits.ts:82-84,202`); keying per *acting* agent would give each fork a fresh 0 and
  let a spawn-fan-out evade the turn cap (G3). Root-keying + the kept reset preserves the aggregate AND is
  concurrency-safe (each session root distinct). `fallback-routing`'s per-run circuit is likewise
  root-keyed (L2 pins whether its `providerName` mutation stays per-acting).
- **Truly per-Agent state** → `WeakMap<Agent>` keyed on `currentActingAgent()`: the pattern
  `circuit-breaker`/`citations`/`output-contract`/`routing` already use for genuinely per-agent-instance
  run-state. (This cycle converts none anew — listed for completeness; the split above is scope, not the
  reset axis: keying-scope = root vs acting; reset-timing = `agent_start`/`session_start`/never is
  orthogonal and preserved per extension.)

Eviction GC's a session's state when its root Agent drops from the pool (no dispose hook — KDD3). Remove
**only the converted extensions' reset closures** (`write-guard.ts:92`, `flow-guard.ts:243`,
`bash-policy.ts:646`, `todo.ts:125`, `goal.ts:524`, `skills-hardening`'s `resetScoping` `:286`) — the
`session_start` reset is already dead for a per-session Agent (that event fires once on `host.agent`,
`server.ts:135`). **Preserve every non-reset `session_start` handler** — notably `skills-hardening`'s
supply-chain-poisoning sweep + fingerprint re-baseline (`:185`) and `integrity`'s tool-description baseline
(`:71`), plus `packages`/`planmode`/`sandbox-tiers`/`headless-flags`/`handoff`/`otel-exporter` load/log
handlers — these are security/integrity baselines, not resets (G1).

### 3c. Two kernel accessors: the `e.agent` getter + `currentRootAgent()`
1. **The getter.** `ExtensionAPI.agent` (`extension.ts:247`, `agent: host.agent,`) becomes
   `get agent() { return currentActingAgent() ?? host.agent; }`; `extension.ts:30`'s type-only Agent import
   gains a **value** import. During a run every `e.agent` read resolves to the acting Agent; at activation/
   commands it resolves to `host.agent` (CLI-correct, server-moot). **Blast-radius re-validated:** ~223
   `e.agent` occurrences / 42 files; **zero capture past activation** (every `= e.agent` is an immediate
   sub-property read, a per-invocation command-handler `const`, or a WeakMap **key** — never a stored
   ref), so the getter is safe. Satisfies `readonly agent: Agent` — no interface/`kernel-surface` change.
2. **`currentRootAgent()` (new kernel primitive).** Returns the **run-tree root** — the top-level Agent —
   from anywhere in the tree, including a fork. Implemented with a second `AsyncLocalStorage` set to the
   root at the top-level run and **inherited** (not overwritten) by children:
   `run()` does `const root = currentRootAgent() ?? this;` then nests `rootAgentStore.run(root, () =>
   actingAgentStore.run(this, … ))`. Top-level run → root = `this`; a fork's `run()` inherits its parent's
   root. Concurrency-safe (per-ALS-context, no shared variable to race). Exported alongside
   `currentActingAgent`; extensions read it via a new `e.rootAgent` getter or the exported function. This
   is the single accessor S1+S2 both require.

### 3d. Root-detection via `currentActingAgent() === currentRootAgent()` (2 sites, security-critical)
`budget-cap.ts:280` (session-cumulative update) and `subagent-jobs.ts:96` `rootOnly()` (recursion guard)
compare `currentActingAgent() === e.agent`. Under the getter that is **always-true** during any run
(incl. a fork) → a fork clobbers the session budget / falsely reads as root and launches jobs. The
2026-07-10 "activation-time `const root = e.agent`" fix is **REFUTED for the server** (it binds
`host.agent`, which under D2 is *no* session's Agent → `=== root` is false for every legitimate session
root → budget never enforces and `launch_job` is refused for all tenants). **Correct fix:** root-detection
is exactly `currentActingAgent() === currentRootAgent()` — true only for a session root, false for a fork,
concurrency-safe (per-ALS-context). Both sites adopt it. **Security-tested both directions** (fork refused,
root allowed) under concurrency (AC4).

### 3e. Concurrent streaming isolation (the linchpin — validated, no kernel change)
Removing the busy lock lets two sessions' turns run concurrently on the **shared** hook bus. The server's
per-session observers (`wireJsonl`, the G1 `error` subscription) must fire for **their own session's whole
tree** (its root run AND its forks' streaming) but **not** another session's. A fork's `text_delta`/
`tool_*`/`message`/`usage` fire the same session-root handlers (childScope shares the parent's event Sets
by reference, `hooks.ts:170`), but at emit `currentActingAgent()` is the **fork**, not the root — so the
guard must key on **`currentRootAgent()` === thisSessionRoot** (the same accessor as the elicitation sink,
3f): true for the session's root AND every fork (they inherit the root), false for another session. Keying
on `currentActingAgent()` would wrongly DROP the session's own sub-agent streaming (a regression vs
today's server). **Empirically validated** for cross-session routing (two ALS-scoped runs, forced
interleave, zero cross-talk); the fork-inclusion follows from `currentRootAgent()` inheritance (also
validated). Extension observers (guards/accounting) stay unguarded — they fire for every session and
isolate via 3b's per-`Agent` state. This also fixes the G1 `errorEmitted` dedup: A's error observer only
fires for A's tree, so B's error can't flip A's flag.

### 3f. Per-session serialization (not a global lock) + shared-server-state isolation
The global single-flight `busy` lock (`server.ts:157,291-300`) is the ONLY serializer of every `/run` —
including two for the **same** session. Two concurrent same-session `/run`s resolve to the **same** Agent
(D2), which races on `Agent.#running` (a second `run()` throws "already running", `agent.ts:222`), the
shared `#abort` (request 2's `onClose` `agent.stop()` aborts request 1, `server.ts:366`), and elicitation
(S3). **Fix: replace the global lock with a PER-SESSION lock** — concurrency *between* tenants, serialize
*within* a tenant. A concurrent same-session `/run` gets **409 busy** (matching today's single-flight
semantics, now scoped per session); different sessions run concurrently. This preserves the Agent's
single-run invariant with no per-request Agent-state aliasing.

Then the remaining shared mutable server state, audited for concurrency:
- **Elicitation** (the `elicit` holder `server.ts:85,334`, `serverUI.ask` `server.ts:113`, `pending`
  `:344`, `/answer` `:241-267`, `drainElicitations` `:353-357`). Today `streamRun` sets a **single mutable
  `elicit.ask` sink** at turn start — under concurrency two turns overwrite it (last-writer-wins), so
  session A's model `ask` would be serviced by B's closure, write `action_required` to **B's** `res`, and
  record the id in B's per-turn set (A never sees its prompt). **Fix: route the ask sink per session
  ROOT.** Hold the ask sinks in a `Map<RootAgent, sink>` (**`currentRootAgent()`** — NOT the acting agent:
  a fork's ask has `currentActingAgent() = child`, but the answering client is the session root's HTTP
  stream); `serverUI.ask` resolves the sink by `currentRootAgent()` and writes `action_required` to that
  session's `res`; `pending` stays one Map keyed by a process-globally-unique ask id; each turn records its
  ask ids in a **per-turn set** and its `finally` drains **only that set** (not the whole map), so A's turn
  end can't settle B's pending ask. `/answer{id,answer}` resolves by the global id. **Sink lifetime:** the
  `Map<RootAgent, sink>` entry is deleted in the turn's `finally` (or a `WeakMap` is used) so a completed/
  evicted session doesn't pin its root Agent or close over its `res` (preserving KDD3's GC teardown). (The
  round-1 "single shared holder + per-turn drain" fixed only the drain, not the sink routing — this
  per-root sink closes the cross-talk.)
- **`sessions` Map** — Map ops are atomic on the single-threaded loop; LRU eviction must **skip the
  actively-running set** (a per-session lock already marks these) so a live session isn't dropped mid-turn.
- **Per-turn subscription lifecycle** — `wireJsonl`+error subs coexist across concurrent turns on the
  shared bus, disambiguated by 3e's `currentRootAgent()` guard; each turn disposes its own in `finally`.
- **`closed`/response writes** — each turn's `write` closes over its own `res` + `closed` flag (per-turn
  closure, not shared); the 3e guard ensures a turn only writes its own events to its own `res`.

## 4. Deliverables

- [x] **D1 (kernel: getter + `currentRootAgent()`)** — the `e.agent` getter (`extension.ts:247`) + a new
      `rootAgentStore` ALS with `currentRootAgent()` (set to the root at top-level `run`, inherited by
      forks; `agent.ts`), the `currentActingAgent` + `currentRootAgent` **value** imports in
      `extension.ts:30`, a new **`readonly rootAgent: Agent`** ExtensionAPI interface member +
      `get rootAgent()` on the API object, and the **`index.ts` barrel export** of `currentRootAgent`
      (`index.ts:15`). Kernel **2249 → ~2262** (single-line getters/comment-lean to stay tight); **bump the
      ceiling to 2265** (KDD5) and reconcile CLAUDE.md. Pin `currentRootAgent` in `kernel-surface.test.ts`.
- [x] **D2 (server per-session Agent pool)** — `Map<session, Agent>`; each session its own Agent sharing
      host registries + fresh config; `agent.run(input)` replaces restore/snapshot; **danglingUser
      rollback retained** (pop a trailing user message left by an aborted run — S2/§3a); LRU eviction skips
      the running set.
- [x] **D3 (root-detection)** — `budget-cap.ts:280` + `subagent-jobs.ts:96` replace `=== e.agent` with
      `currentActingAgent() === currentRootAgent()`. **Security-critical; test both directions (fork
      refused, root allowed) UNDER CONCURRENCY (AC4).**
- [x] **D4 (session-scoped state → `WeakMap<RootAgent>` keyed on `currentRootAgent()`; the 7 security
      guards)** — `write-guard` (`seen`), `flow-guard` (`tainted`/`pending`), `provenance` (`untrusted`),
      `bash-policy` (`approved`), `skills-hardening` (`activeAllowlists`), `subagent-jobs` (`jobs`),
      `budget-cap` (`sessionUsd`) → keyed on the **session root** (shares across the fork tree, isolates
      per session — preserving the flow-guard/provenance cross-agent exfil catch). Remove vestigial resets.
      **Each with a security isolation test (session A vs B) AND a parent↔fork cross-agent-still-shared
      test.**
- [x] **D5 (state → per-Agent; correctness)** — all `currentRootAgent()`-keyed: session-scoped `cost`
      session totals, `goal`, `todo`, `drift-probe`, `handoff` latch (GC'd on eviction); per-run-tree
      `limits` (`toolCallsThisRun`/`tokensThisRun`) + `fallback-routing` (per-run circuit) — **keep their
      `agent_start` reset** (zeroes the root entry per turn; preserves the tree-aggregate bound while fixing
      the concurrency race, G3). `otel-exporter` spans already per-Agent. Non-security.
- [x] **D6 (concurrent streaming + elicitation routing)** — the server passes `wireJsonl` a `write` that
      **guards on `currentRootAgent() === sessionRoot`** (fires for the session's root run AND its forks,
      not another session; guard lives in the *server's* `write`/`error` observers, NOT in `wireJsonl` —
      CLI stays unguarded, `jsonl.ts` unchanged). The ask sink routes **per `currentRootAgent()`** with a
      per-turn drain-set (3f) — one accessor for both streaming and elicitation.
- [x] **D7 (per-session serialization + concurrency)** — replace the global `busy` lock with a
      **per-session lock** (a Set of running session ids; concurrent same-session `/run` → 409; different
      sessions concurrent). A **sessionless `/run`** (no id, no pool key) runs on a **fresh throwaway
      Agent** — no aliasing, no lock needed (G4). Concurrency-safe `sessions` Map; LRU eviction **skips both
      the running set AND any session with a live detached background job** (a `launch_job` `child.run`
      outlives its turn; evicting its root Agent would strand the WeakMap-keyed `jobs`, G5). `subagent-jobs`
      exposes a **server-visible live-job signal** (a shared running-jobs `Set<session>` / store flag — the
      server can't see the extension's private `jobs` map otherwise); `DELETE /sessions/:id` checks the
      same signal; a **sessionless `launch_job` is refused** (no id to ever query the job).
- [x] **D8 (observability)** — `GET /sessions/:id` returns the session's usage + cost summary (per-tenant
      readout + the isolation-test observation seam).
- [x] **D9 (tests)** — (a) two-session **state** isolation for each D4/D5 conversion; (b) **parent↔fork
      cross-agent sharing preserved** for flow-guard/provenance (the S2 regression guard); (c) two-session
      **concurrent** streaming isolation (interleaved in-flight `/run`s — AC3 protocol); (d) root-detection
      under concurrency (AC4); (e) **concurrent same-session `/run` → 409** (AC7); (f) per-session
      elicitation (AC5); (g) existing AC-8 usage/model + CLI single-session stay green.

## 5. Scope Boundary (NOT in scope)

- **`CapabilityManager` stays SHARED** (KDD4): its grant/deny policy must be shared (extension grants land
  on `host.agent.capabilities` at activation). Its per-session ask-memo/audit commingle — **moot under the
  server's default `yolo` (fallback=allow)**, where no ask fires. Per-session memo for a non-yolo
  multi-tenant server is a documented follow-up (needs a shared-policy + per-session-memo kernel mode).
- **`otel-exporter` metric counters, `packages`, `planmode`, `sandbox-tiers` probe, `headless-flags`,
  `integrity`, `checkpoint`/`session`(disk)/`journal`** stay shared/process-global (§2 rationale).
- **No new kernel BUS primitive** — the ALS streaming guard (3e) reuses `currentRootAgent()`; no `HookBus` change,
  no `childScope` change, no CLI change. (The one kernel addition is `currentRootAgent()` — an ALS
  accessor, D1/KDD2 — not a bus change.)

## 6. Key Design Decisions

- **KDD1 — `e.agent` getter, not a 223-site manual repoint.** One kernel change fixes the whole read
  blast-radius, silent-miss-free, CLI-safe. Reject manual repoint (223 sites / 42 files, miss-prone,
  breaks root-detection anyway). Reject per-session host (re-activates 63 extensions + re-spawns MCP per
  session).
- **KDD2 — root-detection via `currentActingAgent() === currentRootAgent()`.** The 2026-07-10
  activation-time `const root = e.agent` capture is **REFUTED for the server**: activation binds
  `host.agent`, which under D2 is *no* session's Agent, so `=== root` is false for every legitimate
  session root (budget never enforces, `launch_job` refused for all tenants). A single `agent_start`-
  observed root variable **races** once the global lock is removed (concurrent sessions' `agent_start`
  clobber it). The correct, concurrency-safe identity is `currentRootAgent()` (D1) — a second ALS set to
  the tree root and inherited by forks, so `currentActingAgent() === currentRootAgent()` is true exactly
  for a session root, per-ALS-context (no shared variable). This is the single accessor both root-detection
  (S1) and session-scoped keying (S2) require.
- **KDD8 — keying-scope = `currentRootAgent()` by default; `currentActingAgent()` only for genuinely
  per-agent-instance state.** Session-scoped state (every security guard's taint/seen/approval, session
  accounting) AND per-run-tree state (`limits`, `fallback-routing` — reset each top-level `agent_start`
  but **aggregating across the fork tree**) both key on **`currentRootAgent()`**. Keying `limits` on the
  *acting* agent would give each fork a fresh counter and let a spawn fan-out evade the per-turn tool cap
  (G3) — and keying a security guard on the acting agent would drop the confused-deputy exfil catch (S2,
  the round-1 error). Keying-scope (root vs acting) is orthogonal to reset-timing
  (`session_start`/`agent_start`/never), which is preserved per extension. `currentActingAgent()` is
  reserved for state that must NOT aggregate across the tree (the existing
  `circuit-breaker`/`citations`/`output-contract`/`routing` per-agent run-state — none newly converted
  here).
- **KDD9 — per-session lock, not a global lock and not lock-free.** Concurrent same-session `/run`s alias
  one Agent (throws `#running` / cross-aborts). A per-session lock (409 on same-session overlap) preserves
  the Agent single-run invariant while allowing cross-tenant concurrency. **Reject** removing the lock
  entirely (same-session aliasing) and **reject** a global lock (no concurrency — defeats the goal).
- **KDD3 — per-session state via `WeakMap<Agent>`; GC teardown** (no `session_end` event). Eviction drops
  the Agent → GC's its state, mirroring existing kernel `WeakMap<Agent>` seams.
- **KDD4 — `CapabilityManager` shared** (see §5).
- **KDD5 — bump kernel ceiling 2250 → 2265.** The getter (+~3) + `rootAgentStore`/`currentRootAgent`/
  `e.rootAgent` + the `readonly rootAgent` interface member + `run()` root-nesting (~+10 total) bust the
  1-line headroom; the per-session isolation seam is a justified core capability (mirrors the 2200→2250
  `Config` precedent). Update `test/kernel-surface.test.ts` + CLAUDE.md. **New kernel export
  `currentRootAgent`** (via `index.ts`) + the ExtensionAPI `rootAgent` member are pinned in
  `kernel-surface.test.ts` — the surface additions this cycle makes, justified by the isolation
  requirement. 2265 leaves ~3 lines slack (measured at L3; golf or re-bump if over).
- **KDD6 — `otel-exporter` metrics stay process-cumulative.** OTel metric counters are process-level
  aggregates by convention; per-session counters would violate the OTel model. Only spans (already
  per-`Agent`) isolate. Documented, not converted.
- **KDD7 — concurrent streaming via ALS guard, not a per-session bus.** The `currentRootAgent()` guard
  (3e; cross-session routing validated, fork-inclusion by inheritance) routes on the shared bus with zero
  kernel change. Reject a per-session `HookBus`
  (childScope shares Sets by reference → cross-talk; suppresses `agent_start` → breaks root-detection) and
  a per-run event sink (a larger kernel change).

## 7. Dependencies and Assumptions

- `Agent` public ctor + readonly `hooks/tools/providers/capabilities`; `run()` wraps
  `actingAgentStore.run(this,…)` (so `currentActingAgent()` is the running session Agent).
- `childScope()` suppresses `agent_start`/`agent_end`/`session_start` for forks (`hooks.ts:36-42`) — so a
  fork does not reset the session's per-run guard state and its `agent_start` doesn't fire.
- **`currentRootAgent()` inheritance:** a fork's `run()` observes the parent's root via the inherited
  `rootAgentStore` ALS context (set once at the top-level run, never overwritten) — so `currentRootAgent()`
  is the session root everywhere in the tree, concurrency-safe (per-ALS-context).
- **Validated:** the ALS-guarded shared-bus routing (3e) — empirical two-session interleave, zero
  cross-talk. Zero `e.agent` capture-past-activation (3c). The two root sites (3d).
- **Baseline (branch `chore/session-isolation` off `init`):** suite 1393 pass / 1 skip; kernel 2249;
  typecheck 0; eval 5/5.

## 8. Acceptance Criteria (measurable / automatable)

- **AC1 (state isolation — security 7):** two sessions A,B across `/run`: each of `write-guard`/`flow-guard`/
  `provenance`/`bash-policy`/`skills-hardening`/`subagent-jobs`/`budget-cap` reflects only the running
  session (A's seen-set/taint/approval/allowlist/jobs/budget do NOT affect B). RED before D4.
- **AC1b (cross-agent exfil catch PRESERVED — SECURITY, the S2 regression guard):** within one session, a
  parent that taints a **closure set** then forks a sub-agent STILL gates the fork's egress/sink via the
  shared session-root key. Test the two closure taints precisely: `flow-guard`'s **capability-taint**
  (parent runs a `shell:exec` source cap → `tainted` grows → the fork's **`net:fetch`/`mcp:call` egress**
  is held — the `tainted` Set gates a genuine egress cap via `isEgress`, `flow-guard.ts:211/:222`; NOT a
  network-shell command, which additionally requires `dataTainted`, `:217-222`) and `provenance`'s
  `untrusted` (parent's `net:fetch` foreign result → fork's sink held). **Not** in scope of root-keying:
  `flow-guard`'s file-read **data-taint** (rides `message.meta`, read from the fork's own transcript,
  `:206-209`) — a parent `fs:read`→fork→egress is a pre-existing data-taint-doesn't-cross-forks
  limitation, unchanged by this cycle (documented, not regressed). RED before D4.
- **AC2 (state isolation — correctness):** cost/goal/todo/drift each reflect only the running session
  (observed via `GET /sessions/:id` + B's request messages). RED before D5.
- **AC3 (concurrent streaming isolation):** two **overlapping in-flight** `/run`s — **protocol:** start
  both `fetch` promises WITHOUT awaiting the first (a MockProvider whose async generator yields across
  microtasks forces interleave; `agent.ts` re-emits per event), read both NDJSON streams — each receives
  **only** its own `text_delta`/`message`/`tool_*`/`usage`/`agent_end`/`error` (zero cross-talk); each
  terminal carries its own session. A sequential-await test would serialize and mask a broken guard — the
  test MUST keep both in flight. RED before D6/D7.
- **AC4 (root-detection under concurrency — SECURITY):** with two sessions' turns in flight, a fork within
  each still cannot `launch_job` and does not clobber its session budget; each session root can. Verifies
  `currentActingAgent() === currentRootAgent()` (D3) is correct AND race-free.
  `node --import tsx --test test/subagent-jobs.test.ts test/budget-cap.test.ts test/server.test.ts`.
- **AC5 (per-session elicitation routing + drain):** with two sessions' turns in flight, A's model `ask`
  writes its `action_required` to **A's** stream (routed by `currentRootAgent()`, not B's); A's
  `POST /answer{id}` resolves A's ask by id; B's concurrent ask is unaffected; A's turn end drains only
  A's per-turn id-set. RED before D6/D7.
- **AC5b (sessionless concurrency):** two concurrent sessionless `/run`s each run on their own fresh Agent
  with no `#running`/abort aliasing and no 409. RED before D7.
- **AC7 (same-session serialization):** a concurrent same-session `/run` (second arrives while the first
  is in flight) gets **409**; the first completes uncorrupted. Different-session overlap does NOT 409.
  RED before D7.
- **AC6 (no regression):** AC-8 usage/model isolation green; CLI single-session green; `npm test` 0 fail;
  typecheck + typecheck:test 0; eval 5/5; build 0; kernel-surface (< 2265, `currentRootAgent`+`rootAgent`
  pinned) green.

## 9. Risks and Rollback

- **R1 (SECURITY) — an unconverted commingle re-opens A→B leakage.** All-or-nothing. Mitigation: AC1
  covers all 7 security conversions; the F review re-audits the full commingling set. Rollback: the
  feature is not shipped partial.
- **R2 (SECURITY) — broken root-detection (D3)** weakens the `subagent-jobs` guard / budget cap.
  Mitigation: AC4 both directions. The getter makes `=== e.agent` always-true, so D3 is mandatory,
  coupled to D1. Rollback: revert D1+D3 together.
- **R3 (concurrency) — the per-session lock exposes a shared-state hazard** (same-session Agent aliasing,
  elicitation, sessions Map, a missed shared observer). Mitigation: per-session lock + AC7 (same-session
  409), 3e's ALS guard (validated), per-turn elicitation drain-set + AC5, the F review + an E2E concurrent
  smoke. Rollback: restore the global lock (Phase A–C state isolation still holds serially — the isolation
  is correct with or without concurrency).
- **R4 — the getter changes `e.agent` globally.** CLI-safe (resolves to the one CLI Agent). Latent
  reliance on `e.agent === host.agent` outside the 2 audited sites → caught by the full suite + isolation
  tests. Rollback: revert D1 (inert with one shared agent).
- **Decomposition — 4 L3 phases**, isolate all state FIRST (serial, safe), enable concurrency LAST; each
  independently committable + green + a **fresh security review**:
  - **Phase A (mechanism, still serial):** D1 (getter + `currentRootAgent()` + ceiling bump + surface pin)
    + D2 (per-session Agent pool) + D3 (root-detection via `currentActingAgent() === currentRootAgent()`)
    — **keep the global lock** (turns stay serial). AC4 + full regression green. **D1 and D3 are coupled
    and land in the SAME commit** (the getter makes `=== e.agent` always-true, so D3 must accompany it —
    the PHASE is independently committable, D1 alone is not).
  - **Phase B (security state, serial):** D4 (7 security guards → `currentRootAgent()`-keyed) + AC1 + AC1b
    (cross-agent exfil catch preserved).
  - **Phase C (correctness state + observability, serial):** D5 (session-scoped + run-scoped incl.
    `limits`/`fallback-routing`) + D8 + AC2.
  - **Phase D (concurrency, LAST — flip it on only once all state is isolated):** D6 (streaming guard) +
    D7 (global lock → per-session lock, elicitation per-turn-set) + AC3 + AC5 + AC7 + an E2E concurrent
    smoke. Closeout.
  Rationale: with the global lock retained through A–C, no concurrency race can exist while state
  isolation is landed and verified; Phase D introduces cross-session concurrency only after every
  commingle is closed — so a partially-landed feature is never a live cross-tenant leak.
- **Overall rollback:** kernel (getter + `currentRootAgent`) + server + ~15 extensions + tests; each phase
  reverts independently; Phase D reverts to the serial (global-lock) server, which is still correctly
  state-isolated. Branch `chore/session-isolation`, PR to `init`.

## 10. Known limitations (whole-cycle audit dispositions)

The whole-cycle adversarial audit (6 dimensions × 3-lens verify, zero severe) surfaced these; each is a
conscious disposition, recorded so it does not silently vanish.

- **L1 (deferred finding) — a detached `launch_job`'s frames surface in a later same-session `/run`
  stream.** A background job started in run #1 outlives that turn; its events inherit the session **root**,
  so the root-scoped streaming guard (which is per-*session*, not per-*request*) writes them into whatever
  same-session `/run` is in flight when they fire. This is **within one session** (one tenant) — never
  cross-tenant — and is strictly narrower than the pre-cycle single-Agent server, where such frames could
  reach *any* session. Proper fix (per-request stream routing for detached jobs) is deferred as a follow-up;
  it needs its own design (the job would carry a request-scoped sink, not just a root identity).
- **L2 (ratified) — `GET /sessions/:id` inherits the single process-wide bearer token.** State is now
  isolated per session, but the `session` id remains a *multiplexing* key, **not** a per-tenant
  authorization boundary: any holder of `EAGENT_TOKEN` can read any session's usage+cost by id. This is
  unchanged from the documented threat model — one token is one trust domain; isolate tenants at the
  process/token boundary. Documented in `SECURITY.md`.
- **L3 (ratified) — CLI `/reload` no longer resets `write-guard`/`bash-policy` state.** `reload` also emits
  `session_start` (`extension.ts:179`), so the pre-cycle `session_start` reset closures cleared the seen-set
  and shell approvals on every `/reload`. D4 removed those closures (the state is now root-keyed and GC'd on
  eviction). Net effect on the CLI's single long-lived Agent: read-before-write state and shell approvals
  now **persist across a hot code-reload** — ratified as correct, since `/reload` swaps extension code
  within a *continuing* session and does not invalidate prior reads or user consent. The server is
  unaffected (per-session Agents; `reload` fires on the host agent only).
