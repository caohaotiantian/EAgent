# Design — Full per-session isolation for the HTTP server (Cycle I)

Slug: `2026-07-10-session-isolation`
Status: **closed — won't-build (in-process isolation); posture documented instead**
Closed-on: 2026-07-11
Superseded-by: `docs/design/2026-07-14-multitenant-isolation.md` — the in-process isolation this doc
scoped but deferred was ultimately built there (2026-07-15); its getter/root-detection mechanism and
commingling enumeration are carried forward and expanded.
Decision: The L1 loop (two rounds, no code) proved full in-process per-session isolation is a ~15-
extension, security-critical, **all-or-nothing** subsystem (§Review Log). The user chose the
production-standard posture (2026-07-11): **isolate tenants at the process boundary**, not in-process.
Shipped instead (Light Mode, one fresh review): a `SECURITY.md` "Cross-session isolation" bullet + a
"one process per tenant" deployment rule, an operator-visible server-startup notice (`server.ts`), and
a `README` pointer. This document is **retained as the specified, twice-reviewed design** should
in-process multi-tenancy ever be built — the getter mechanism (validated), D3 root-detection, the full
commingling enumeration, and the observability seam are all captured below.

## Review Log

- **L1 round 1 (rev 1):** two SEVERE — (1) the `e.agent` repoint was massively under-scoped
  (~45 reads / 19 extensions), (2) ACs not automatable. → rev 2 pivots to the kernel getter + adds
  root-detection (D3) + observability (D9).
- **L1 round 2 (rev 2):** both round-1 severes RESOLVED; the **getter blast-radius probe passed**
  (no wrong-agent path found — the getter is validated, and is *required* for routing/fallback-routing
  under per-session Agents). **One new SEVERE:** the commingling enumeration is incomplete. Because
  `session_start` is emitted **once at server startup** (`server.ts:134`), *every* extension that
  resets only on `session_start` holds state for the whole process and commingles across HTTP
  sessions — not just cost/goal/todo/drift/budget. Source-confirmed additions, **several
  security-critical**: `write-guard` (`seen` clobber-guard set, `:66` — B overwrites A's file without
  the prompt), `flow-guard` (`tainted`/`pending`, `:97/:106` — A's exfil taint gates B's egress),
  `bash-policy` (`:646`), `sandbox-tiers` (`:151`), `skills-hardening` (`:286`), `integrity` (`:71`),
  `planmode` (`:94`), `packages` (`:223`), `handoff` (`:536`), `headless-flags` (`:428`). Generals:
  KDD1's "verified safe" evidence misstated (bare `= e.agent` captures DO exist in `templates.ts`/
  routing/fallback-routing — conclusion survives via a different invariant); D9's cost-getter seam
  hand-waved (fix: server keeps its own per-session cost from the `usage` events `streamRun` already
  subscribes to); §6 conflates the single-flight lock with `AsyncLocalStorage` scoping; AC3
  under-operationalized.
- **Consequence (why this reframes the cycle):** "full per-session isolation" for the security
  guards is **all-or-nothing** — a server that isolates cost/goal but leaves write-guard/flow-guard
  commingling *looks* isolated while leaking security decisions across tenants, which is **strictly
  worse** than an honestly-documented single-tenant server. The true scope is now proven to be ~15
  extensions (5 security-critical) + kernel getter + server pool + root-detection + observability + a
  large test surface — a security-sensitive subsystem, not a hardening batch. **Escalated to the user
  (clarification-needed route): full in-process multi-tenant isolation vs. the production-standard
  one-process-per-tenant posture the server already supports.**

## 1. Background and Purpose

The HTTP server runs every session's turn on **one shared `Agent`** (`createAgentHost` once,
`server.ts:115`; restore→run→snapshot per turn under a single-flight lock, `server.ts:378-406`). Only
per-session **AgentState** (transcript/usage/model) is isolated; extension state accumulated in the
single activation commingles across sessions — cost totals + anomaly window (`cost.ts:167-179`), otel
metric counters (`otel-exporter.ts:156-168`), goal/todo (`goal.ts:306-308`, `todo.ts:79`, reset only
on the once-emitted `session_start`), drift counters (`drift-probe.ts:205-215`), budget cumulative
(`budget-cap.ts:187-188`). The kernel's per-agent seam (`currentActingAgent()` + `WeakMap<Agent>`)
keys on the Agent *object*, and the server has one Agent, so it isolates sub-agent forks, not
sessions.

**The chosen approach (user, 2026-07-10): per-session Agents.** Give each session its own `Agent`
that **shares** the host's registries; the `WeakMap<Agent>` seam then isolates per session.

## 2. The blast radius and the mechanism decision (why a getter, not a manual repoint)

A per-session Agent means `e.agent` (which extensions close over, `= host.agent`) is **no longer the
running agent**. A grep found **~45 `e.agent.<running-state>` reads across ~19 extensions** (model,
messages, snapshot, providerName — reads *and* mutations like `routing.ts:313` `e.agent.model = …`,
`fallback-routing` `e.agent.providerName = …`). Manually repointing all 45 to
`currentActingAgent() ?? e.agent` is large and silent-miss-prone.

**Decision: a single kernel getter.** Change `ExtensionAPI.agent` from the fixed `agent: host.agent`
(`extension.ts:247`) to `get agent() { return currentActingAgent() ?? host.agent; }`. During a session
Agent's run every `e.agent` read resolves to that session Agent; at activation and in commands
(outside a run) it resolves to `host.agent` — CLI-correct (the CLI's one Agent) and server-moot (no
command route). This fixes all ~45 sites at once with no silent-miss risk. Verified safe: **no
extension captures `e.agent` into an activation-outliving variable** (grep confirms every `= e.agent`
is already the `currentActingAgent() ?? e.agent` idiom); a getter satisfies `readonly agent: Agent`
(no interface/`kernel-surface` export change); `currentActingAgent` is exported from `agent.ts:76`.

**The one idiom the dynamic `e.agent` breaks — root detection.** Two sites identify the run *root* via
`=== e.agent`: `budget-cap.ts:280` (session-cumulative update) and — security-critical —
`subagent-jobs.ts:96` `rootOnly()` (the recursion guard refusing job tools from a sub-agent). With a
dynamic `e.agent`, `currentActingAgent() === e.agent` is always true (both are the acting agent), so a
fork would falsely read as root. A **manual repoint breaks these too** (differently: `=== host.agent`
is false for the session root, so a session could not launch jobs / the budget never enforces) — so
root-detection must be rebuilt regardless of mechanism. **Fix:** `childScope()` **suppresses
`agent_start`** for sub-agents (`hooks.ts:36-39`), so `agent_start` fires only for a top-level (session
root) run. Capture the root Agent on `agent_start` and use `currentActingAgent() === rootAgent`.

## 3. Deliverables

- [ ] **D1 (kernel)** — `ExtensionAPI.agent` becomes `get agent() { return currentActingAgent() ??
      host.agent; }` (`extension.ts`); add the `currentActingAgent` value-import. ~+2 kernel lines
      (2246 → ~2248 < 2250 — measured at L3; escalate if over). No interface/export change.
- [ ] **D2 (server)** — each session runs on its **own `Agent`** sharing the host's
      `hooks`/`tools`/`providers`/`capabilities`/`ui`/`logger` and pristine `model`/`systemPrompt`/
      `thinking`/`maxTurns`/`provider`/`maxConcurrency` (`agent.ts:40-57` opts, `:79-84` public
      fields). The session pool is `Map<session, Agent>` (LRU-capped by `EAGENT_MAX_SESSIONS`), each
      Agent holding its own transcript/usage — replacing the AgentState snapshot pool. Elicitation,
      the danglingUser guard, and usage reporting operate on the session's own Agent. CLI untouched.
- [ ] **D3 (root detection)** — `budget-cap` and `subagent-jobs` capture the run root on `agent_start`
      (fires only for the session root, `childScope` suppresses it for forks) and replace
      `=== e.agent` with `=== rootAgent`. This preserves the session budget attribution and the
      `subagent-jobs` recursion guard under per-session Agents. **Security-critical; test both.**
- [ ] **D4–D8 (per-Agent state)** — convert the session-scoped closure/store globals to `WeakMap<Agent,
      …>` keyed on `currentActingAgent() ?? e.agent` (= the session Agent during a run), mirroring
      `budget-cap.ts:181`/`otel-exporter.ts:69`: **cost** (`sessionUsd`/`sessionTokens`/`perModel`/the
      `window`), **otel-exporter** metric counters (`tokenUsage`/`toolCalls`/`opDuration`), **goal**
      (`objective`/`criteria`/`lastCheck`), **todo** (`items`), **drift-probe**
      (`turnCounter`/`probeCount`/baseline), **budget-cap** cumulative (`sessionUsd`). The
      store-backed data (cost `window`, drift baseline) moves in-memory into the WeakMap (per-
      conversation analytics; GC'd on session eviction — no dispose hook, KDD3). The `session_start`/
      `session_shutdown` reset handlers in goal/todo become vestigial (isolation comes from the key)
      and are removed.
- [ ] **D9 (observability)** — `GET /sessions/:id` returns the session's usage + cost summary (the
      per-tenant readout the multi-tenant feature needs *and* the mechanism the isolation tests
      observe). The server, holding the session Agent, reads a per-Agent cost getter cost exposes.
- [ ] **D10 (tests)** — two-session isolation across `/run`: cost, goal-pin, todo, drift, and budget
      each reflect **only** the running session; the `subagent-jobs` recursion guard still refuses a
      fork under per-session Agents (security regression test); the existing AC-8 usage/model isolation
      and the CLI single-session tests stay green.

## 4. Scope Boundary (NOT in scope)

- **The `CapabilityManager` is SHARED across session Agents (intentionally, documented).** Its
  grant/deny/fallback policy *must* be shared (extension grants land on `host.agent.capabilities` at
  activation). Its per-session `#remembered` ask-memo + audit therefore commingle — **moot under the
  server's default `yolo` (fallback=allow), where no ask/memo fires.** Per-session capability memo for
  a *non-yolo* multi-tenant server is a documented follow-up (it needs a shared-policy + per-session-
  memo CapabilityManager mode — a kernel change out of this cycle).
- **`checkpoint`/`session`(disk)/`journal`** are process-global by nature (one workspace, disk by
  explicit id, one file) — a separate follow-up; not per-Agent-keyed here.
- **No `store` re-plumbing** (the per-session data moves to in-memory WeakMap, not a session-namespaced
  store); **no `childScope`/single-flight/AgentState-shape change**; **no CLI change**.

## 5. Key Design Decisions

### KDD1 — `e.agent` getter vs 45-site manual repoint vs per-session host
See §2. **Getter chosen:** one kernel change fixes the whole read blast-radius with no silent-miss
risk, CLI-safe. **Reject manual repoint:** 45 sites across 19 files, silent-miss-prone, and it breaks
root-detection anyway. **Reject per-session host:** re-activates 62 extensions + re-spawns MCP
subprocesses per session — untenable at `EAGENT_MAX_SESSIONS` (1000) scale.

### KDD2 — Root detection via `agent_start` (childScope-suppressed), not `=== host.agent`
See §2. **Chosen:** capture the root on `agent_start` (fires only for the session root). **Reject
`=== e.agent`:** broken by the dynamic getter. **Reject a kernel depth/parent primitive:** more kernel
surface than the `agent_start` seam, which already exists.

### KDD3 — Per-session state via `WeakMap<Agent>`; GC teardown
Keying on the session Agent object means eviction (dropping it from the pool) GC's its state — no
per-session dispose hook, mirroring the kernel's existing `WeakMap<Agent>` seams. **Reject** a new
`session_end` event + per-extension subscription (redundant surface).

### KDD4 — `CapabilityManager` shared (documented), not per-session
See §4. The grant policy must be shared for extension grants to apply; the ask-memo is moot under
`yolo`. A per-session-memo mode is a follow-up. **Reject** forcing a per-session CapabilityManager now
(a kernel change that would strand extension grants or need a shared-policy mode this cycle can't
justify).

## 6. Dependencies and Assumptions

- `Agent` public constructor + public `readonly hooks/tools/providers/capabilities` (`agent.ts:40-57`,
  `:79-84`); `run()` binds `actingAgentStore.run(this,…)` (`agent.ts:220-221`); single-flight lock
  (`server.ts:290-299`) ⇒ one session Agent runs at a time ⇒ `currentActingAgent()` unambiguous and
  `rootAgent` (captured on `agent_start`) is the running session's root.
- `childScope()` suppresses `agent_start`/`agent_end`/`session_start` for sub-agents (`hooks.ts:36-39`).
- No extension captures `e.agent` past activation (grep-verified); the two `=== e.agent` root sites are
  `budget-cap.ts:280` + `subagent-jobs.ts:96`.
- Per-agent pattern to mirror: `budget-cap.ts:181` `stateFor`, `otel-exporter.ts:69` `traces`.
- Test harness: `test/server.test.ts` `withServer`/`mockOf`/the AC-8 template (`:181-244`);
  `test/subagent-jobs.test.ts` rootOnly tests (`:181-229`).
- **Measured baseline:** suite 1319 pass / 1 skip; kernel 2246; typecheck 0.

## 7. Acceptance Criteria (measurable / automatable)

- **AC1 (cost/budget isolation):** two sessions A, B; after A runs N times and B once, `GET
  /sessions/B` cost reflects **only** B, and a per-session budget cap counts only that session's spend
  (A's runs don't push B toward B's cap — observable on the `/run` stream). RED before D4/D8.
- **AC2 (goal/todo isolation):** a goal/todo set in session A (tool via `/run`) does **not** appear in
  session B's context — asserted via `mockOf(http).script((req)=>…)` inspecting B's request messages
  for A's goal pin / todo note. RED before D5/D6.
- **AC3 (drift isolation):** drift-probe's turn counter/baseline for B is independent of A's — B's
  probe cadence starts fresh. RED before D7.
- **AC4 (recursion guard intact — SECURITY):** under per-session Agents, a sub-agent within a session
  still cannot `launch_job` (`subagent-jobs` rootOnly holds); a session root still can. RED-verify the
  root-detection fix (D3) — a broken fix would let a fork launch jobs or block the root. Command:
  `node --import tsx --test test/subagent-jobs.test.ts test/server.test.ts`.
- **AC5 (no regression):** AC-8 usage/model isolation stays green; CLI single-session tests stay green;
  `npm test` 0 fail; typecheck 0; eval 5/5; build 0; kernel-surface (< 2250) green; a grep confirms
  the getter is the sole `e.agent` change and no `e.agent.<state>` read remains that needs the acting
  agent but bypasses the getter.

## 8. Risks and Rollback

- **R1 (SECURITY) — a broken root-detection (D3) weakens the `subagent-jobs` recursion guard or the
  budget cap.** Mitigation: AC4 red-verifies both directions (fork refused, root allowed); the getter
  makes `=== e.agent` always-true, so D3 is mandatory, not optional. Rollback: revert D1 (getter) +
  D3 together (they are coupled — the getter necessitates the root-detection fix).
- **R2 — the getter changes `e.agent` semantics globally** (all extensions + the CLI). CLI-safe
  (`currentActingAgent() ?? host.agent` = the one CLI Agent). Any latent extension relying on
  `e.agent === host.agent` outside the two audited sites would break — the D2/D10 isolation tests +
  the full suite catch it. Rollback: revert D1.
- **R3 — the server run-path rewrite (D2)** must preserve elicitation/danglingUser/usage. The session
  Agent owns its state natively (simpler than snapshot/restore). Covered by the existing server tests.
  Rollback: revert D2 (restore the snapshot pool) — but D1's getter is then inert (still correct: with
  one shared agent, `currentActingAgent()` during its run = host.agent, unchanged behavior).
- **R4 — store-backed data (cost window, drift baseline) moves in-memory** (lost on restart).
  Acceptable per-conversation analytics; documented. Rollback: per-datum revert.
- **Decomposition:** given the size and the kernel+security surface, this ships as **three L3 phases**
  — (I) the mechanism: getter + server per-session Agent pool + D3 root-detection + the AC4 security
  test; (II) the per-Agent conversions D4–D8; (III) the D9 observability endpoint + AC1–AC3 isolation
  tests — each independently committable and green. Every phase touches the security surface, so each
  runs the full four-corner + a fresh security-focused review.
- **Overall rollback:** kernel (1 getter line) + server + ~6 extensions + tests; each phase reverts
  independently; branch `chore/production-hardening` (PR #40), not merged.
