# Design — Acting-agent seam (childScope governance correctness)

**Slug:** `2026-06-29-acting-agent-seam` · **Wave:** 9 (subsystem W9.1 of 6) · **Mode:** Full
**Source:** [`docs/audits/2026-06-29-production-readiness-audit.md`](../audits/2026-06-29-production-readiness-audit.md) §3 (RW3-1, RW3-2, otel-keying) · **Research:** Node `AsyncLocalStorage` (`node:async_hooks`).

## 1. Background and the gap (code as truth)

Wave 3 made gate filters (`beforeToolCall`/`afterToolCall`) and intra-run events *fire* for sub-agents via
`HookBus.childScope()` (`hooks.ts:167`). But the guard extensions that consume them act through `e.agent`,
which is bound **once at activation to the parent** (`extension.ts:108`, `:241` `agent: host.agent`). The
Agent has **no stable id** and emits **no acting-agent reference** in any of its ~22 hook payloads/contexts
(`agent.ts:225-498`). Two distinct bugs follow when a child runs under `childScope` (concurrently, for
reasoning-search forks):

- **Wrong-agent actions / reads.** `flow-guard` reads the parent transcript at a sink
  (`flow-guard.ts:164` `e.agent.messages`); `circuit-breaker` steers the parent (`circuit-breaker.ts:156`);
  `budget-cap` stops/steers the parent (`budget-cap.ts:280,298`); `output-contract` writes parent
  `forceTool`/`output` + stops/steers the parent (`output-contract.ts:177,144,183,187,154,170`).
- **Per-run state collision.** Each guard's accumulators live in the activate closure, **keyed by nothing
  agent-specific**: `flow-guard` `tainted`/`pending` (`:96,:105`), `circuit-breaker` `buckets` (`:86`),
  `budget-cap` `runUsd`/`tripped`/`activeModel` (`:166-174`), `output-contract` `attempts` (`:101`),
  `otel-exporter` `currentTraceId`/`openSpans`/`finished` (`:45-48`). Concurrent parent+child (or N forks,
  each restarting turns at 1 — `agent.ts:231`) overwrite each other: otel's `openSpans["1"]` collides across
  forks; budget commingles spend; circuit-breaker mixes call signatures.

Hard enforcement (the dispatcher blocking a child's *own* vetoed call) already works (`agent.ts:498-506`),
so this is **soft-guard governance correctness**, not a containment hole. The fix needs two things in every
guard handler: **(a) which agent is acting**, and **(b) a key to partition per-run state by agent**.

## 2. Deliverables

- [ ] **D1 — kernel seam: `currentActingAgent()` via `AsyncLocalStorage`.** In `agent.ts`, a module-level
  `const actingAgent = new AsyncLocalStorage<Agent>()` (`node:async_hooks` — a built-in, **not** an npm
  dep). `run()` wraps its whole body in `actingAgent.run(this, async () => { …existing body… })`. Export
  `currentActingAgent(): Agent | undefined` from `agent.ts` and the barrel (`index.ts`). **~7 kernel lines;
  no ceiling raise** (2187 → ~2194/2200). No change to `events.ts`, no change to the ~22 emit/apply sites,
  no payload/context type churn. Correct under concurrency: each child's `run()` is its own async context,
  so a parent guard fired through the child's shared bus reads the child (KDD-1).
- [ ] **D2 — `flow-guard`** (two independent triggers, S2): (1) the **shared capability `tainted` Set**
  fed by *source* caps (default `shell:exec`, `:34,:96,:119-123`), checked at the sink as `tainted.size>0` —
  this is the **cross-agent** catch (a child runs a `shell:exec` source, then *any* agent's egress is
  blocked) and **stays shared** (KDD-3); (2) **per-message data taint** (`fs:read` of a sensitive path /
  sensitive content → `message.meta.flowGuardTaint`, `:128-156`), checked at the sink via
  `e.agent.messages.some(...)` (`:164`). D2 fixes **(2)**: at the sink (`beforeToolCall`, `:161`) and the
  status/clear paths read the **acting** transcript — `const agent = currentActingAgent() ?? e.agent;` then
  `agent.messages` — so a child that reads a secret and *the same child* egresses is caught on the child's
  own transcript (intra-child; pre-seam the sink read the parent's transcript and missed it). `capsOf`
  (`:114`) may keep reading `e.agent.tools`: a child's registry is a strict subset of the parent's identical
  tool objects (`subagents.ts:473-480`), so cap resolution is identical (C2). No-child behavior unchanged.
- [ ] **D3 — `circuit-breaker`:** steer the acting agent (`currentActingAgent() ?? e.agent`); key `buckets`
  by the acting agent (`WeakMap<Agent, Map<sig,Bucket>>`) so a child's repeated calls don't trip on the
  parent's history and vice-versa. The `agent_start` reset becomes a per-acting-agent reset (delete that
  agent's entry), not a global `buckets.clear()` (C3).
- [ ] **D4 — `budget-cap`:** at the `usage` event and the `beforeToolCall` block, resolve the acting agent
  for `stop()`/`steer()`; key the per-run accumulators (`runUsd`/`tripped`/`softWarned`/`activeModel`) by
  the acting agent. **`activeModel` is stamped in the child-suppressed `agent_start` today** (`:174,:246`),
  so for a child it must be **lazily initialized** from `currentActingAgent().model` on that agent's first
  `usage` (G2). `sessionUsd` (cross-run cumulative) stays shared — but it is assigned from the acting
  agent's `p.cumulative` (`:261`), so a child `usage` would clobber it with the child's smaller cumulative
  (pre-existing, both caps default off); fix by updating `sessionUsd` **only for the root agent**
  (`currentActingAgent()` has no parent / equals the bound `e.agent`), G2. The reset is per-acting-agent (C3).
- [ ] **D5 — `output-contract`:** when a **child** trips the shared `afterToolCall` reask, read/write
  `forceTool`/`output` and `stop()`/`steer()` on the **acting** agent (not the parent), and key
  `attempts`/`respondReg` by the acting agent. (A child's *own* typed output is handled by
  `subagents.runTypedChild`, not this guard — the `respond` tool is registered in the child-suppressed
  `agent_start` on the parent's registry — so D5 is scoped to "don't corrupt the parent when a child trips
  the shared reask," nothing more; G3 — the earlier "child governed independently" parenthetical is dropped.)
- [ ] **D7 — `routing`** (G1): the shared `turn_start` handler (`routing.ts:254`) reads `e.agent.messages`
  and writes `e.agent.model` (`:266-272`) — fired on a *child's* turn it classifies the child's prompt but
  reassigns the **parent's** model and never routes the child. Read/write the **acting** agent
  (`currentActingAgent() ?? e.agent`). (Off by default; opt-in.)
- [ ] **D8 — `citations`** (G1): the shared `afterToolCall` (`citations.ts:130`) mutates closure state
  `sources`/`nextId` reset on the child-suppressed `agent_start` (`:125-147`); under concurrent forks
  `nextId++`/`sources.set` commingle. Key `sources`/`nextId` by the acting agent (`WeakMap<Agent,…>`), lazy-
  init on first intra-run use (since `agent_start` is suppressed for children). (Off by default.)
- [ ] **D6 — `otel-exporter`** (telemetry-only; the leak is real, but the fix must respect that
  `agent_start`/`agent_end` are **suppressed for children** — S1). Today otel creates the root span +
  `currentTraceId` in `agent_start` (`:106-121`) and flushes in `agent_end` (`:180-190`); a child fires
  neither, so a naïve per-agent `WeakMap` keyed off `agent_start` would give children **no root span**
  (`turn_start` bails at `if(!agent) return`, `:125-126`) and **no flush** → zero child spans, worse than
  today. Correct design:
  - Per-agent trace state in a `WeakMap<Agent, RunTrace>` (`{ traceId, openSpans, rootSpanId,
    currentTurnSpanId }` — `currentTurnSpanId` is a module var today, `:141`, and must move into the per-agent
    entry so child tool spans parent to the child's current turn), **lazily created on the first INTRA-RUN
    event** for that acting agent (`turn_start`/`tool_start` — synthesize a fresh `traceId` + a root span if
    the WeakMap has no entry), not on the suppressed `agent_start`. The parent still seeds its entry at
    `agent_start`. **Flush mechanics (G1 — the WeakMap is not enumerable):** eager-**push each lazily-created
    root span into the shared `finished` buffer** at creation (with an open `endTimeUnixNano`); at flush,
    stamp a best-effort end ts on any span still open. So flush iterates only `finished` (+ `openSpans` via
    the per-agent entries it closes), never the WeakMap.
  - `openSpans` keyed within the per-agent entry by `turn`/`call.id` — so concurrent forks (each restarting
    turns at 1) no longer collide on a global `openSpans["1"]`, and spans parent within their own agent's
    trace.
  - **Flush via a shared `finished` buffer drained at the parent's `agent_end` + `session_shutdown`**
    (children complete *within* the enclosing parent's run — the spawn tool / `best_of_n` `Promise.all`
    awaits them before the parent ends), closing any still-open per-agent root span at flush time
    (best-effort end ts). Child traces are thus emitted (distinct, correctly-parented) and flushed when the
    enclosing run ends. Read `model`/`providerName` off the acting agent.

## 3. Out of scope

The 20 by-design items (audit §4). Also: a *public* Agent id (the `WeakMap<Agent,…>` keying needs only
object identity, which `currentActingAgent()` provides — no new id field, smaller surface). `subagents`/
`teams`/`templates` need no change (they already fork via `new Agent` + `childScope`; the seam is automatic).

## 4. Key Design Decisions

### KDD-1 — `AsyncLocalStorage` ambient acting-agent, not payload threading
*Problem:* every guard handler needs the acting agent + a per-agent state key, in both shared filter
contexts AND several intra-run event payloads. *Options:* (a) **thread** an `agent: Agent` field into the
shared contexts (`beforeToolCall`/`afterToolCall`) + the consumed event payloads (`usage`, `agent_start`,
`turn_*`, `tool_*`, `message`) and populate `agent: this` at each emit/apply — ~10 payload-type additions in
`events.ts` + a circular `import type { Agent }` + ~10 call-site edits ≈ **13-15 kernel lines (at/over the
13-line ceiling)**, and it solves (a) but each guard still must thread the key into its own state; (b)
**`AsyncLocalStorage`**: `run()` wraps its body in `actingAgent.run(this, …)`, guards call
`currentActingAgent()`. *Choice:* **(b)** — ~7 kernel lines (no ceiling raise), zero `events.ts`/payload
churn, and one idiomatic mechanism gives BOTH the acting agent and a WeakMap key. ALS is the canonical Node
pattern for "ambient current context across async": each child's `run()` is a distinct async context, so a
parent handler invoked *during the child's `emit`/`apply` await chain* reads the child even when N forks run
concurrently under `Promise.all` (the parent's `Promise.all` of `child.run()` gives each child its own ALS
scope). `node:async_hooks` is a built-in (like `node:fs`/`node:crypto` already used), so the zero-deps rule
holds. *Rejected:* (a) — more kernel lines (ceiling-breaching), broad type churn, a circular import, and
still leaves state-keying to each guard; explicit-over-implicit is real but does not justify the cost here,
and the small-kernel bet favors the smaller seam.

### KDD-2 — Per-run guard state keyed by acting agent (`WeakMap<Agent, State>`)
*Problem:* closure-singleton accumulators collide across concurrent parent+child. *Options:* (a) leave
shared (today — collides); (b) key by a string agent-id (needs a new kernel id field + lifecycle for
eviction); (c) `WeakMap<Agent, State>` keyed by the acting-agent object from `currentActingAgent()`.
*Choice:* **(c)** — object identity needs no new kernel field, and a `WeakMap` self-evicts when the (child)
agent is GC'd, so forks don't leak state. *Rejected:* (a) the bug; (b) extra kernel surface for an id we
don't otherwise need.

### KDD-3 — Capability `tainted` Set stays cross-agent; only the data-taint transcript read moves (flow-guard)
*Problem:* should `flow-guard`'s `tainted` **capability** Set be per-agent? *Options:* (a) per-agent
(isolates child taint from parent); (b) keep shared. *Choice:* **(b)** — the `tainted` Set is fed by
*source* caps (default `shell:exec`); a child running a `shell:exec` source then **any** agent's egress is
exactly the cross-boundary exfiltration the guard exists to catch (this is what the existing test exercises,
`governed-subagents.test.ts:63-125`), so isolating it per-agent would *open* that hole. The **separate**
data-taint check ("is THIS agent's conversation tainted by an `fs:read` of a sensitive path/content") rides
the agent's transcript and so moves to the acting agent (D2) — that fix is **intra-child** (data taint never
crosses into the parent's transcript: a spawn returns only the child's final text, `subagents.ts:112-113`).
*Rejected:* (a) regresses the capability cross-agent catch.

### KDD-4 — Compose, no new primitive; fallback preserves today's behavior
Every guard uses `currentActingAgent() ?? e.agent`, so outside a `run()` (e.g. a command handler) or when
the seam is absent, behavior is byte-identical to today. No new extension; six edits + one tiny kernel seam.

## 5. Acceptance Criteria (measurable, offline)

- **AC-1** `npm run typecheck` 0. **AC-2** `npm test` 0 (existing + new). **AC-3 (kernel ceiling)**
  `kernel-surface` green; the test is **strict `< 2200`** (2200 fails, `kernel-surface.test.ts:68`), so the
  **documented** seam (code + JSDoc) must land **≤ 2199** — mechanical delta is ~7 lines (→ ~2194), keep the
  ALS/`currentActingAgent` doc-comments tight (G4); `currentActingAgent` added to `EXPECTED_EXPORTS` (a
  `test/` edit, outside the kernel count).
- **AC-4 (acts on the child)** With a parent `circuit-breaker`/`output-contract` active, run a **child**
  Agent under `parent.hooks.childScope()` that triggers the guard: assert the guard steers/stops/writes the
  **child** (child `messages`/`output`/stopped), and the **parent is untouched** (parent not steered/
  stopped). Pre-seam this fails (acts on parent).
- **AC-5 (no state collision under concurrency)** Run two children concurrently (`Promise.all`) under one
  parent's `childScope` with `circuit-breaker` (or `budget-cap`): assert each child's bucket/spend reflects
  only its own calls (the WeakMap partition), and the parent's own counters are independent.
- **AC-6 (otel namespacing + child spans emitted)** Two concurrent forks each emit `turn_start(1)`/
  `tool_start` (under one parent run): assert the flushed spans (at the parent's `agent_end`) include **each
  fork's** spans under a **distinct `traceId`** with correct intra-trace parenting and **no `openSpans["1"]`
  overwrite** — i.e. child spans are present and non-colliding, not zero (the S1 lazy-init + shared-finished
  + flush-at-parent-end path).
- **AC-7 (flow-guard: cross-agent capability + intra-child data taint)** (a) a child runs a `shell:exec`
  source, then **any** agent's default egress sink is **held** (the shared `tainted` Set — KDD-3,
  cross-agent, preserved); (b) a child `fs:read`-taints its **own** transcript and the **same child**
  egresses → **held** because the sink reads the acting (child) transcript (D2 intra-child). (The
  pre-seam-impossible "child fs:read → parent egress" case is *not* claimed — S2.)
- **AC-8 (no-child parity)** With no sub-agent, all five guards behave byte-identically to pre-seam
  (regression: the existing guard suites stay green unchanged).

## 6. Risks and Rollback

- **R1 — ALS context lost across an await boundary the loop doesn't own.** *Mitigation:* `run()` wraps its
  entire body, and all emit/apply are awaited *inside* it; ALS propagates across `await`/`Promise.all` by
  design. AC-5/AC-6 (concurrent forks) pin it. *Residual:* a guard that defers work to a bare
  `setTimeout`/`queueMicrotask` outside the await chain would lose context — none do; documented.
- **R2 — `WeakMap` keyed by agent never cleared mid-run.** *Mitigation:* per-run reset stays on
  `agent_start` (suppressed for children, so a child's first turn initializes its own entry); the WeakMap
  self-evicts on GC. *Rollback:* revert the guard to the shared singleton.
- **R3 — behavior drift for the common (no-child) path.** *Mitigation:* `?? e.agent` fallback + AC-8 parity.
- **R4 — kernel ceiling (strict `<2200`).** *Mitigation:* ALS keeps the mechanical delta ~7 lines (→~2194);
  AC-3 enforces the **documented** seam ≤2199 — keep JSDoc terse. If it can't fit ≤2199, that surfaces an
  explicit ceiling decision (not silently breaching); the fallback is to trim comments, not raise the bet.
- *Rollback:* the seam is additive (a new export + a `run()` wrapper); reverting the six guard edits +
  the seam restores today's behavior exactly.
