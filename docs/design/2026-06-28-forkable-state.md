# Design — First-class forkable state (snapshot / restore / step ids)

```
Status: closed
Closing-commit: 2bd6227
Closed-on: 2026-06-28
Deferred: deliverable — Agent.fork() (RW4-1, Wave 8); finding — server cross-session capability-audit/store bleed (RW4-2) — docs/DEFERRED-FOLLOWUPS.md
```

**Slug:** `2026-06-28-forkable-state` · **Wave:** 4 · **Mode:** Full
**Source:** [`docs/ROADMAP.md`](../ROADMAP.md) · **Strategy:** [`2026-06-28-eagent-redesign-blueprint.md`](2026-06-28-eagent-redesign-blueprint.md) §3 P1.3

## 1. Background and Purpose

Agent state is not a first-class object. The transcript is a private array (`agent.ts:98` `#messages`)
exposed **live and mutable** through the tool-facing handle (`agent.ts:137` `messages: this.#messages`,
typed `readonly` but the actual backing array — a tool can cast and splice it mid-run). There is no
`snapshot`/`restore`, no step index. Consequences:

- **No durable resume with fidelity, no time-travel, no cheap state copy** for best-of-N / Tree-of-Thoughts
  search (Wave 8) or event-sourced resume (Wave 7) — all of which need to *address and copy* a point in
  the agent's state. Today resume is whole-transcript replay (`server.ts:325-329`, `agent.clear()` +
  `agent.load(history)`), which loses usage/model/thinking and reasoning-block fidelity.
- **Cross-session bleed in the HTTP server** (the most direct violation of the "uniform across
  embeddings" consequence): `server.ts` shares **one** `Agent` across all sessions, isolating only the
  transcript (`sessions: Map<string, Message[]>`, `server.ts:127`). `done.usage` reports
  `agent.usage` = **process-lifetime** cumulative, not the session's (`server.ts:343`); `model`,
  `systemPrompt`, and `thinking` also bleed across sessions.
- **Live-mutable handle**: a tool holding `ctx.agent.messages` can mutate the running transcript
  (`agent.ts:134-141`).

This wave makes state a first-class, copyable object: `Agent.snapshot()` / `Agent.restore(state)`, a
monotonic per-run `#step` stamped on turn/tool events, and a frozen tool-facing `handle.messages`. It
then uses snapshot/restore as the **named consumer** to isolate the HTTP server's per-session state. It
is the precondition for Wave 7 (event-sourced resume / rewind-to-step) and Wave 8 (reasoning-search
`fork`).

## 2. Deliverables

- [ ] **D1** `Agent.snapshot(): AgentState` — returns a self-contained copy of the conversational state:
  `{ messages, usage, model, providerName, systemPrompt, thinking, step }`, with `messages` and `usage`
  **deep-copied** (`structuredClone`) and primitives copied, so mutating the returned `AgentState` cannot
  affect the live agent. `AgentState` is an exported kernel type.
- [ ] **D2** `Agent.restore(state: AgentState): void` — replaces those seven fields on the agent from the
  state (deep-copying back in, so the live agent and the passed `AgentState` stay independent). Throws if
  called while `running`.
- [ ] **D3** A monotonic `#step: number` (starts 0, increments once per turn at `turn_end`), exposed in
  the `turn_end` and `tool_end`/`tool_batch_end` event payloads (additive fields) and captured in
  `AgentState`. **Reset mechanism (specified, KDD-3):** `clear()` resets `#step` to 0 (alongside
  `#messages`); `restore()` sets it from the state; `run()` **never** auto-resets it. So a standalone
  agent doing repeated `run()` calls keeps `step` **monotonic across the whole conversation**, while the
  server (which now `restore()`s the session snapshot per turn — D5; its old `clear()` becomes vestigial,
  since `restore()` already replaces `#messages`/`#step`) gets the session's step. **Emit ordering:**
  `turn_end` carries the count **after** this turn's increment; a mid-turn `tool_end` carries the count at
  call time (pinned by AC-7).
- [ ] **D4** The tool-facing `handle.messages` returns a **frozen shallow copy**
  (`Object.freeze(this.#messages.slice())`) — closes the named "cast and splice the backing array" hole
  (§1): array-**structure** mutation (push/splice/reorder) is blocked and the array is a distinct object,
  so a tool cannot add/remove/reorder transcript entries. This is **shallow by design** (KDD-4): the
  copied elements are the same `Message` references, so in-place edits to a message's `content`/`meta`
  remain possible — deep-freezing every handle read is disproportionate (a tool that holds a message
  object can already read it; the supported way to *add* to the transcript is `steer`/`followUp`). The
  public `Agent.messages` getter is unchanged (KDD-4).
- [ ] **D5** `server.ts` per-session isolation: store `AgentState` per session
  (`Map<string, AgentState>`); on `/run`, `restore` the session's snapshot (or an `initial` snapshot
  captured at startup for a new session), run, then `snapshot()` back; `done.usage` reports the session's
  usage. (Residual: shared `CapabilityManager` audit log + `Store` still cross-session — out of scope, KDD-5.)
- [ ] **D6** Tests for each. `AgentState` is exported as a **type** (`export type`), which is
  runtime-erased under `verbatimModuleSyntax`, so it does **not** appear in `Object.keys(kernel)` and the
  `kernel-surface.test.ts` `EXPECTED_EXPORTS` list needs **no** change (it pins runtime values only). Only
  the `< 2,200` line-ceiling assertion applies.

## 3. Scope Boundary (NOT in scope)

- **No** `Agent.fork()` — its consumer is Wave 8's reasoning-search controller; the server (a sequential,
  single-flight consumer) needs only snapshot/restore. `fork()` is deferred to its consumer (KDD-2).
- **No** per-session isolation of the `CapabilityManager` audit log or the namespaced `Store` — these
  remain process-shared in the server (D5 isolates conversational state + usage only). Documented residual
  needing `fork()` or per-session managers (KDD-5).
- **No** change to the public `Agent.messages` getter (only the tool-facing `handle.messages`) — the
  documented hole is the handle (KDD-4).
- **No** rewind-to-step command / event-sourced log (Wave 7) and **no** branch/search controller (Wave 8)
  — this wave ships only the primitive they build on.
- **No** snapshot of transient/config fields (`forceTool`, `outputSchema`, `maxTurns`) — snapshot is
  conversational state + accounting, not config (KDD-1).

## 4. Key Design Decisions

### KDD-1 — `AgentState` shape
*Problem:* which fields constitute restorable state? *Options:* (a) messages only; (b) messages + usage;
(c) `{ messages, usage, model, providerName, systemPrompt, thinking, step }`; (d) (c) plus transient/config
(`forceTool`, `outputSchema`, `maxTurns`). *Choice:* **(c)**. These are the fields that define "where the
conversation is and what it has cost"; restoring them reproduces a turn's starting conditions. *Rejected:*
(a)/(b) lose model/usage fidelity that resume needs; (d) snapshots config (`maxTurns`) and transient
forcing (`forceTool` is cleared each turn) that are not conversational state and would surprise on restore.

### KDD-2 — Ship snapshot/restore now, defer `fork()`
*Problem:* the blueprint floated `fork()` (a child Agent reusing registries with a deep-copied transcript).
*Options:* (a) add `fork()` now; (b) ship snapshot/restore + step ids, defer `fork()` to its consumer.
*Choice:* **(b)** — Simplicity First: the only Wave-4 consumer (the server) is sequential and needs
restore-into-the-same-agent, not a second live agent. `fork()` is a thin composition
(`new Agent({…registries}).restore(parent.snapshot())`) best designed when Wave 8's search controller
defines its needs (governed branches via `childScope`). *Rejected:* (a) adds public surface ahead of a
consumer.

### KDD-3 — `#step` granularity and placement
*Problem:* what does `step` index, and where is it incremented/exposed? *Options:* (a) per appended
message (finest); (b) per tool wave; (c) **per turn**, exposed on `turn_end` + `tool_end`/`tool_batch_end`.
*Choice:* **(c)** — a monotonic per-run counter incremented at `turn_end`, stamped on the turn/tool event
payloads (additive) and captured in `AgentState`. It gives observers (Wave 7 event-sourced resume) a
stable per-turn checkpoint id without per-message churn; finer granularity can be added by its consumer if
needed. *Rejected:* (a) high-churn, no current consumer needs message-level; (b) ambiguous across turns
with no tool calls.

### KDD-4 — Freeze the tool-facing handle only
*Problem:* `handle.messages` hands tools the live `#messages` array. *Options:* (a) freeze a copy in both
`handle.messages` and the public `Agent.messages` getter; (b) freeze only `handle.messages`. *Choice:*
**(b)** — the documented hole is the tool-facing handle (`agent.ts:134-141`); tools are the untrusted
surface. The public `Agent.messages` getter is used by trusted hosts/extensions for frequent reads
(`server.ts:342`, many extensions) where an O(n) frozen copy per access is wasteful and identity-changing.
Returning `Object.freeze(this.#messages.slice())` from the handle closes the hole at the right boundary.
The freeze is **shallow by design** (array-structure only — the named "cast and splice" hole, §1); a
deep freeze/copy on every read is disproportionate and identity-churning (D4). *Rejected:* (a) imposes
copy cost on every trusted read for no security gain (extensions already get the full `Agent`); a deep
freeze is rejected for the same cost reason.

### KDD-5 — Server per-session isolation scope (conversational state + usage, not capability/store)
*Problem:* the server shares one Agent; what does snapshot/restore isolate? *Options:* (a) isolate
everything (per-session `Agent` via `fork` + per-session `CapabilityManager`/`Store`); (b) isolate the
conversational state + usage via snapshot/restore, leave `CapabilityManager` audit + `Store` shared.
*Choice:* **(b)** — snapshot/restore cleanly isolates `messages`/`usage`/`model`/`systemPrompt`/`thinking`
per session (fixing the `done.usage` lifetime-cumulative bug and model/prompt bleed) with no new
primitive; full isolation needs `fork()` (deferred, KDD-2) and per-session managers (a larger change). The
residual (shared capability-audit + store) is documented. *Rejected:* (a) pulls deferred `fork()` and a
manager rework into this wave.

### KDD-6 — `restore` forbidden while running
*Problem:* restoring mid-run would corrupt the loop's in-flight state. *Options:* (a) allow; (b) throw if
`this.#running`. *Choice:* **(b)** — mirrors `run()`'s own `if (this.#running) throw` guard (`agent.ts:169`);
snapshot/restore are between-turn operations. *Rejected:* (a) invites undefined behavior.

## 5. Dependencies and Assumptions

Builds on Wave 1 (widened `Usage` — `structuredClone` of `usage` copies the optional cache fields too) and
is independent of Waves 2/3. Assumes `structuredClone` handles `Message[]` — both the `ContentBlock`
variants (`types.ts:65`: text/tool_call/tool_result/thinking/image, all plain data) **and**
`Message.meta` (`types.ts:81-85`, the `Record<string,unknown>` extension escape hatch; every built-in
writes plain JSON-able `meta`). Use **raw** `structuredClone` (fail-loud on a non-cloneable value), NOT
the `structuredCloneSafe` helper in `validate.ts:171-177` whose `catch { return v }` would return the
**live** reference and re-introduce the aliasing snapshot exists to prevent. Assumes the server's
single-flight lock (`server.ts:128`) means restore→run→snapshot is never interleaved across sessions. **Reasoning-fidelity note:** OpenAI/Gemini currently drop reasoning blocks
from `done.message` (a separate audited gap, deferred to Wave 6 P2.4); snapshot/restore is lossless for
whatever the transcript holds, so it does not *introduce* the gap, but full reasoning-fidelity resume
depends on Wave 6.

## 6. Relationship with Existing Designs

Strategy parent: blueprint §3 P1.3. Independent of Waves 2/3 (no shared surface). Related:
`2026-06-22-white-box-memory.md` and the `session`/`journal`/`checkpoint` extensions (resume today via
`agent.load`/`clear` — this adds the higher-fidelity primitive they will migrate to in Wave 7; ⚠ not a
conflict, a foundation). CLAUDE.md Agent-loop primitive row + the `types.ts` `Usage`/`AgentHandle` section
gain `AgentState`/snapshot/restore; reconciled at F. No load-bearing contract removed.

## 7. Acceptance Criteria (measurable, automatable)

- **AC-1** `npm run typecheck` exits 0.
- **AC-2** `npm test` exits 0 (existing + new).
- **AC-3** New `agent.test.ts` case: `snapshot()` then mutate the returned `state.messages`/`state.usage`
  → the live agent's `messages`/`usage` are unaffected (deep copy).
- **AC-4** New case: run a turn, `snapshot()`; run more / change `model`; `restore(snap)` → `agent.messages`,
  `agent.usage`, `agent.model`, `systemPrompt`, `thinking`, and `step` match the snapshot.
- **AC-5** New case: `restore()` while `running` throws.
- **AC-6** New case: `handle.messages` (via a tool's `ctx.agent.messages`) is `Object.isFrozen`, is a
  distinct array object from the internal one, and a `push`/`splice` to it throws/no-ops and does not
  change the agent's transcript length (array-structure protection — the documented shallow scope).
- **AC-7** New case: `#step` is 0 before the first turn, increments by 1 per turn, and the `turn_end`
  (and `tool_end`) event payloads carry the current `step`.
- **AC-8** New `server.test.ts` case: two sessions A and B; after A consumes tokens, B's `done.usage` is
  **B's** usage (not A+B); a model change in A's turn does not affect B; a fresh session starts from the
  initial snapshot (empty transcript, zero usage).
- **AC-9** `kernel-surface.test.ts` passes **unchanged** to `EXPECTED_EXPORTS` (`AgentState` is a
  type-only export, runtime-erased, so it is not in `Object.keys(kernel)`); `src/kernel/` stays
  `< 2,200` lines (the test counts `split("\n").length`; current ≈ 2,035, ≈ 165 headroom).

*Quality budget:* `snapshot`/`restore` are O(transcript size) `structuredClone` calls, invoked between
turns (not a hot path); the per-turn `#step` increment is O(1). Excluded from a numeric budget.

## 8. Risks and Rollback

- **R1 — `structuredClone` fails on a non-cloneable message** (e.g. a future block carrying a function).
  *Mitigation:* `ContentBlock` is plain data today (`types.ts:65`); add a focused test (AC-3). *Rollback:*
  revert `snapshot`/`restore`; they are additive methods.
- **R2 — Server per-session change alters `done.usage` semantics** (lifetime → per-session). *Mitigation:*
  this is the intended fix; AC-8 pins it; update any server test asserting cumulative usage. *Rollback:*
  restore the `Map<string, Message[]>` + `agent.load`/`clear` path.
- **R3 — Freezing `handle.messages` breaks a tool that mutated it.** *Mitigation:* mutating the handle
  transcript was never supported (the type is `readonly`); the full suite (AC-2) is the net; tools that
  need to add messages use `ctx.agent.steer`/`followUp`. *Rollback:* return the live array.
- **R4 — Event-payload `step` field + the per-agent nature of `step`.** *Mitigation:* `AgentState` is a
  type-only export (no `kernel-surface` pin change, D6); the `step` fields on `turn_end`/`tool_end`/
  `tool_batch_end` are additive (no consumer breaks). **Caveat (for the Wave-7 consumer):** `#step` is
  **per-agent-run**, not tree-global. Wave-3 `childScope` shares those non-suppressed events by reference,
  so a sub-agent's `turn_end` (carrying the **child's** own `#step`, also starting at 0) fires the
  **parent's** handlers — harmless in Wave 4 (no consumer), but a Wave-7 event-sourced-resume observer
  must disambiguate child vs parent steps (e.g. by an agent id; ties to the deferred RW3-4 tagging).
  *Rollback:* drop the `step` fields.
- **R5 — Kernel line ceiling.** The test counts `split("\n").length` ≈ **2,035** today (≈ 165 headroom);
  this adds ≈ 50-70 → ~2,085-2,105. *Mitigation:* keep `snapshot`/`restore` terse; AC-9 enforces
  `< 2,200`. *Rollback:* n/a.
- **R6 — CLAUDE.md / README primitive descriptions stale.** *Mitigation:* reconcile at F step 8.

The kernel change is two methods + one counter + a frozen-copy accessor; reverting them restores prior
behavior, and the server change is independently revertible.

## L1 Review Log

- **Round 1** — **SEVERE**: D6/AC-9 misread `kernel-surface.test.ts` (a type-only `AgentState` export is
  runtime-erased → must NOT be added to the pinned list). + general (`#step` reset mechanism;
  shallow-freeze). + clarifications (structuredClone meta / raw-not-Safe; childScope per-agent step; stale
  agent.ts cites; ceiling metric). All fixed.
- **Round 2** — **zero severe, zero general** (2 optional clarifications: vestigial server `clear()`;
  step emit-ordering). Folded in.
- **Round 3 (confirming)** — **zero severe, zero general.** Two-generation satisfied. **L1 closed.**
