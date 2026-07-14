# Implementation — Full concurrent in-process multi-tenant isolation

Slug: `2026-07-14-multitenant-isolation` (matches the design)
Status: **L2 closed** (2026-07-14). Rounds 1–3 (zero severe throughout); round 3 passed
zero-severe/zero-general with every source citation and the `test/*` accept files verified. Ready for L3.
Fixes landed: danglingUser rollback = snapshot/restore; cross-boundary channels via `host.storeFor(id)`
accessors (`costOf`/`hasLiveJob`); `fallback-routing.baselineProvider` root-keyed (races otherwise);
Phase C accept + AC4-under-concurrency added.

## 1. Task Index

Design: `docs/design/2026-07-14-multitenant-isolation.md`. Deliverables D1–D9 → the 4 phases below;
Acceptance AC1–AC7 → per-phase exit conditions; KDD1–KDD9 → the design. `<TEST-CMD>` = `npm test`.

**Ordering principle (design §9): isolate all state FIRST (serial), enable concurrency LAST** — the global
lock is kept through Phases A–C so no concurrency race can exist while state isolation lands; Phase D flips
on cross-session concurrency only after every commingle is closed.

- **Phase A** — mechanism (kernel getter + `currentRootAgent()` + ceiling; per-session `Agent` pool +
  danglingUser rollback; root-detection). D1+D2+D3. Serial (global lock kept). AC4.
- **Phase B** — the 7 security-guard state conversions → `currentRootAgent()`-keyed. D4. AC1 + AC1b.
- **Phase C** — the correctness conversions + observability. D5 + D8. AC2.
- **Phase D** — concurrency: per-root streaming guard + per-session lock + per-root elicitation +
  sessionless + job-eviction. D6 + D7. AC3 + AC5 + AC5b + AC7 + E2E.

## 2. Phase Breakdown

### Phase A — mechanism (D1 getter + `currentRootAgent()` + D2 pool + D3 root-detection)

- **Entry:** branch `chore/session-isolation`, suite 1393 pass / 1 skip; kernel 2249/2250.
- **Design refs:** §3a/§3c/§3d; D1/D2/D3; KDD1/KDD2/KDD5; AC4.
- **Task list (TDD order):**
  1. **T-A1 (tests, RED):**
     - `test/kernel-surface.test.ts`: bump the ceiling assertion to `< 2265`; add `currentRootAgent` to the
       pinned exports; add `rootAgent` to the pinned `ExtensionAPI` members.
     - `test/agent.test.ts`: `currentRootAgent()` is `undefined` outside a run; equals the agent inside its
       own `run`; a **fork's** `run` (nested) observes the **parent's** root (inheritance); two concurrent
       top-level runs have distinct roots (mirror the scratchpad root-ALS validation).
     - `test/extension.test.ts`: `e.agent` resolves to `currentActingAgent()` during a run, `host.agent` at
       activation; `e.rootAgent` resolves to `currentRootAgent()` during a run.
     - `test/server.test.ts` (AC4, RED): a session root can `launch_job`; a **fork within a session** is
       refused `launch_job` and does not clobber the session budget (drive via `mockOf(http).script`).
     - `test/server.test.ts`: an aborted first turn leaves NO dangling `user` message on the persistent
       session Agent's next turn (danglingUser rollback, AC-8-adjacent).
  2. **T-A2 (impl — kernel D1):** `src/kernel/agent.ts` — add `rootAgentStore = new AsyncLocalStorage<Agent>()`;
     in `run()` wrap `const root = currentRootAgent() ?? this;` then
     `rootAgentStore.run(root, () => actingAgentStore.run(this, () => …existing body…))`; export
     `currentRootAgent = () => rootAgentStore.getStore()`. `src/kernel/extension.ts` — value-import
     `currentActingAgent`+`currentRootAgent`; `agent:` → `get agent() { return currentActingAgent() ??
     host.agent; }`; add `readonly rootAgent: Agent` to the `ExtensionAPI` interface + `get rootAgent() {
     return currentRootAgent() ?? host.agent; }`. `src/kernel/index.ts` — barrel-export `currentRootAgent`.
     **Golf to stay ≤2265** (single-line getters, lean comments); measure with the surface test.
  3. **T-A3 (impl — server D2):** `src/server.ts` — replace `Map<session, AgentState>` with
     `Map<session, Agent>`; a session's turn runs on its own `Agent` built from the host registries
     (`hooks`/`tools`/`providers`/`capabilities`/`ui`/`logger`) + fresh config (`model`/`systemPrompt`/
     `thinking`/`maxTurns`/`provider`/`maxConcurrency` from host defaults); `agent.run(input)` replaces
     restore/snapshot. **danglingUser rollback mechanism** (Agent has no `pop`): capture
     `const pre = agent.snapshot()` **before** `agent.run(input)`; after, if `agent.messages.at(-1)?.role
     === "user"` (an abort baked a bare user turn), `agent.restore(pre)` to discard it — a transient
     per-turn snapshot for rollback only (NOT the removed per-session state pool; uses the existing
     `snapshot()`/`restore()` API, no kernel change). Keep the **global busy lock** (serial — Phase D
     removes it).
  4. **T-A4 (impl — root-detection D3):** `budget-cap.ts:280` + `subagent-jobs.ts:96` `rootOnly()` →
     `currentActingAgent() === currentRootAgent()`.
- **Accept:** `node --import tsx --test test/agent.test.ts test/extension.test.ts test/kernel-surface.test.ts test/server.test.ts test/subagent-jobs.test.ts test/budget-cap.test.ts`
- **Exit:** those green; `npm test` 0 fail; typecheck + typecheck:test 0; build 0; eval 5/5; kernel < 2265.
  **D1+D3 land in ONE commit** (coupled — the getter makes `=== e.agent` always-true).

### Phase B — security-guard state → `currentRootAgent()`-keyed (D4)

- **Entry:** Phase A merged.
- **Design refs:** §2 (security-7), §3b (session-scoped), D4, KDD3/KDD8, AC1/AC1b.
- **Task list (TDD order):**
  1. **T-B1 (tests, RED):** `test/server.test.ts` two-session isolation for each of `write-guard`
     (`seen`), `flow-guard` (`tainted`), `provenance` (`untrusted`), `bash-policy` (`approved`),
     `skills-hardening` (`activeAllowlists`), `subagent-jobs` (`jobs`), `budget-cap` (`sessionUsd`) —
     session A's guard state does NOT affect B (AC1). **AC1b:** within one session, a parent that runs a
     `shell:exec` source cap (flow-guard `tainted`) / a `net:fetch` foreign result (provenance) STILL gates
     a **fork's** `net:fetch`/`mcp:call` egress/sink (cross-agent catch preserved).
  2. **T-B2 (impl):** convert each of the 7 guards' session-scoped closure/store globals to
     `WeakMap<Agent, …>` keyed on `e.rootAgent` (= `currentRootAgent() ?? e.agent`); **remove the converted
     extensions' `session_start`/`session_shutdown` reset closures** (write-guard:92/93, flow-guard:243/244,
     bash-policy:646/647, todo:125/126, goal:524/525, skills-hardening `resetScoping`:286/287) — **preserve
     every non-reset `session_start` handler** (skills-hardening supply-chain sweep :185, integrity :71,
     etc.). `subagent-jobs`'s `jobs` map + `idBase` become per-`rootAgent`.
- **Accept:** `node --import tsx --test test/server.test.ts test/write-guard.test.ts test/flow-guard.test.ts test/provenance.test.ts test/bash-policy.test.ts test/skills-hardening.test.ts test/subagent-jobs.test.ts test/budget-cap.test.ts`
- **Exit:** those green + AC1/AC1b; `npm test` 0 fail; gates green; kernel unchanged (< 2265, no kernel edit).

### Phase C — correctness state + observability (D5 + D8)

- **Entry:** Phase B merged.
- **Design refs:** §2 (non-security), §3b, D5/D8, KDD6, AC2.
- **Task list (TDD order):**
  1. **T-C1 (tests, RED):** two-session isolation for `cost`/`goal`/`todo`/`drift-probe`/`handoff` (AC2);
     `limits`/`fallback-routing` root-keyed with the `agent_start` reset kept — a fork's tool calls
     **aggregate** onto the session's per-turn cap (not a fresh per-fork counter). `GET /sessions/:id`
     returns the session's usage + cost summary (D8).
  2. **T-C2 (impl):** convert `cost` (sessionUsd/perModel/window), `goal`, `todo`, `drift-probe`, `handoff`
     → `WeakMap<RootAgent>`; `limits` (`toolCallsThisRun`/`tokensThisRun`) + `fallback-routing`'s per-run
     state (`circuit` AND **`baselineProvider`** — the pre-run provider captured on `agent_start` `:243` and
     restored on `agent_end` `:251`; a shared closure singleton that would otherwise race B's write over A's)
     → `WeakMap<RootAgent>` **keeping the `agent_start` reset** (zeroes the root entry). The
     `agent.providerName` **field** mutations (`:245/:251/:271`) stay as-is — they write the session Agent's
     own field (per-Agent, concurrency-safe; the §3b L2-pin). **Cross-boundary channel (G2):**
     `usage` is already on the Agent (`agent.usage`), so `GET /sessions/:id` reads it directly; for cost,
     the `cost` extension **publishes a `costOf(agent): number` accessor into the shared store** under a
     well-known key at activation, and the server calls it with the session Agent (no new host API).
     `otel-exporter` metrics stay shared (KDD6).
- **Accept:** `node --import tsx --test test/server.test.ts test/cost.test.ts test/goal.test.ts test/todo.test.ts test/drift-probe.test.ts test/limits.test.ts test/handoff.test.ts test/fallback-routing.test.ts`
- **Exit:** green + AC2; gates green.

### Phase D — concurrency (D6 streaming guard + D7 per-session lock/elicitation)

- **Entry:** Phases A–C merged (all state isolated, still serial).
- **Design refs:** §3e/§3f, D6/D7, KDD7/KDD9, AC3/AC5/AC5b/AC7.
- **Task list (TDD order):**
  1. **T-D1 (tests, RED):**
     - **AC7:** a concurrent same-session `/run` (second in-flight) → 409; the first completes uncorrupted;
       different-session overlap does NOT 409.
     - **AC3:** two overlapping in-flight `/run`s (start both fetches, DON'T await the first) → each stream
       receives ONLY its own events (incl. its own forks' `tool_*`/`text_delta`), zero cross-talk.
     - **AC5:** A's model `ask` writes `action_required` to A's stream (not B's) under two concurrent
       sessions; A's `/answer{id}` resolves A's ask; A's turn-end drains only A's ids.
     - **AC5b:** two concurrent sessionless `/run`s each on a fresh Agent, no 409, no aliasing.
     - **AC4-under-concurrency:** re-run the fork-refusal / root-allowed root-detection with two sessions'
       turns in flight (Phase A verified it serially; per-ALS-context makes it race-free by construction —
       KDD2 — this confirms it under real interleave).
  2. **T-D2 (impl — D6):** the server's `write` (passed to `wireJsonl`) + the `error` observer guard on
     `currentRootAgent() === sessionRoot`. The elicitation ask sink → `Map<RootAgent, sink>` routed by
     `currentRootAgent()`; `serverUI.ask` resolves the sink by `currentRootAgent()`; per-turn drain-set;
     delete the sink entry in the turn's `finally` (no root pin).
  3. **T-D3 (impl — D7):** replace the global `busy` lock with a per-session running-`Set<session>` (409 on
     same-session overlap); a **sessionless `/run`** runs on a fresh throwaway Agent (no lock);
     `subagent-jobs` **publishes a `hasLiveJob(agent): boolean` accessor into the shared store** (over its
     per-`rootAgent` `jobs` WeakMap); LRU eviction + `DELETE /sessions/:id` map session→Agent (the server
     holds `Map<session, Agent>`) and **skip a session in the running set OR where `hasLiveJob(agent)`**;
     a sessionless `launch_job` is refused (no id to query it).
  4. **T-D4 (E2E):** a concurrent-isolation smoke on the real server (two interleaved `/run`s, offline mock)
     — each wire stream carries only its own session's events + terminal.
- **Accept:** `node --import tsx --test test/server.test.ts` + the E2E smoke.
- **Exit:** AC3/AC5/AC5b/AC7 green; `npm test` 0 fail; gates green; the F concurrent-E2E smoke passes.

## 3. Engineering Constraints Index

- **Engineering norms** — CLAUDE.md: ESM `.js` specifiers; strict TS (no `any`); **kernel change is D1
  only** (getter + `currentRootAgent` + `rootAgent` member — ceiling 2265, one export addition, justified
  by the isolation seam); everything else is extension/server. Comments explain code, not the workflow.
- **Security discipline** — all-or-nothing: Phase B converts all 7 security guards or the feature is not
  shipped; each guard gets an AC1 isolation test AND (flow-guard/provenance) an AC1b cross-fork test. The F
  review re-audits the full commingling set.
- **Four-corner template** — `references/loop-3-development.md`; each phase = dev/review/accept/fix + a
  **fresh security-focused review**.
- **Commit conventions** — `feat(phaseN):` / `fix(phaseN-roundR): <keyword>`; results as trailers; no
  AI/model/tooling mention.

## 4. Data and Fixture Dependencies

- `test/server.test.ts`'s `withServerHandle`/`mockOf`/`readNdjson` harness; a fork is driven by scripting
  the mock to emit a `spawn_agent`/`launch_job` tool call. AC3/AC5's interleave uses a MockProvider whose
  `async*` generator yields across microtasks (already the case) + concurrent un-awaited `fetch`es.
  `EAGENT_AGENT_MAX_TURNS` / `EAGENT_MAX_SESSIONS` env for bounded tests. All offline.

## 5. Regression Protection

Must stay green each phase: the full suite; the existing AC-8 usage/model isolation + elicitation +
CLI single-session tests; every converted extension's own tests (the WeakMap conversion must not change
single-session behavior). Final gate per phase: `npm test`, `npm run typecheck`, `npm run typecheck:test`,
`npm run build`, `npm run eval` (5/5), `test/kernel-surface.test.ts` (< 2265; kernel edited only in
Phase A).
