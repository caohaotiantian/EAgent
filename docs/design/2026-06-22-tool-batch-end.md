# tool_batch_end — a wave-settled lifecycle event for once-per-parallel-batch checks

Status: design
Date: 2026-06-22
Author: design author (EAgent)

## 1. Background and Purpose

The agent loop dispatches a **parallel tool wave** and emits no seam for "this
wave has settled". Today the loop emits only two relevant signals around tool
execution:

- a per-tool `tool_end` notification, emitted once per individual tool inside
  `runOne` (`src/kernel/agent.ts:310` — `await this.hooks.emit("tool_end", { call, result: finalResult })`); and
- a turn-level `turn_end` notification, emitted once per loop iteration
  (`src/kernel/agent.ts:219` — `await this.hooks.emit("turn_end", { turn })`),
  which also fires on a pure-text turn that ran no tools at all
  (`src/kernel/agent.ts:197,201`).

Between them sits the actual unit of work that has no event: the group of tool
calls dispatched together in `dispatch()`. That group resolves either via
`Promise.all(calls.map((call) => this.runOne(call)))` for a parallel wave
(`src/kernel/agent.ts:298`) or, when any tool declares
`executionMode === "sequential"`, via an in-order loop
(`src/kernel/agent.ts:293-297`). Either way, `dispatch()` returns the **ordered
`{call, result}` pairs** for the whole wave (`src/kernel/agent.ts:288`,
returning `DispatchOutcome[]`, shape defined at `src/kernel/agent.ts:367-370`)
before the caller appends the single `tool` message (`src/kernel/agent.ts:205-218`).

Because there is no wave-scoped event, any **cross-cutting wave check** — an
incremental typecheck after a group of edits, a once-per-wave secrets sweep, a
per-wave cost rollup — has no place to attach. It must either run redundantly on
every `tool_end` (N times for an N-tool wave, then de-duplicate by hand) or
cannot see the wave as a single unit at all. Citadel (the comparison system in
the spec) exposes exactly such a batch-level hook; EAgent currently does not.

**Purpose:** add a single **additive, observe-only** lifecycle event
`tool_batch_end` to `KernelEvents` (`src/kernel/events.ts:11-38`) that carries
the settled wave as ordered `{call, result}` pairs, emitted **once** per
`dispatch()` group. The kernel only emits; every consumer is an extension. This
is the minimal additive change to the hook-bus primitive: no new filter, no
behavior change, no veto power — purely a new notification on the existing
`HookBus.emit` path (`src/kernel/hooks.ts:50-61`).

## 2. Deliverables

- [ ] **Event type addition** — extend the `KernelEvents` map in
  `src/kernel/events.ts` with `tool_batch_end: { batch: { call: ToolCallBlock; result: ToolResult }[] }`.
  (`ToolCallBlock` and `ToolResult` are already imported at
  `src/kernel/events.ts:9`.)
- [ ] **Single emit** — one `await this.hooks.emit("tool_batch_end", { batch })`
  in `Agent.run`, placed **after** `const results = await this.dispatch(calls)`
  (`src/kernel/agent.ts:205`) and **before** the `tool` message is appended
  (`src/kernel/agent.ts:217`) and before `turn_end`
  (`src/kernel/agent.ts:219`). The payload is the already-ordered
  `results` array (`DispatchOutcome[]`) mapped to `{ call, result }`, i.e.
  the same field names `dispatch` already returns.
- [ ] **Test** — extend `test/agent.test.ts` (alongside the existing parallel
  and tool-use cases at `test/agent.test.ts:8-58`) with assertions that:
  (a) a **3-tool parallel wave** produces **exactly one** `tool_batch_end`;
  (b) its `batch` carries the **ordered** `{call, result}` pairs in requested
  order (matching the order assertion at `test/agent.test.ts:55-57`);
  (c) `tool_end` still fires **once per tool** (3×) and `turn_end` still fires
  unchanged for the same run; (d) a single-tool wave emits exactly one
  `tool_batch_end` with a length-1 batch.
- [ ] **host.ts registration** — **N/A by design.** `tool_batch_end` is a kernel
  event, not an extension, so there is **no** `src/extensions/` file and **no**
  builtin entry in `src/host.ts`. This box is checked when the reviewer confirms
  the absence is intentional (see Scope Boundary).
- [ ] **Command** — **N/A by design.** No slash command; an observe-only kernel
  event has no user-facing control surface. Checked when confirmed intentional.
- [ ] **Kill switch** — **N/A by design.** A new notification with zero
  consumers is inert; nothing fires unless an extension subscribes, and the
  rollback (Section 8) is a two-line revert. No env var is added. Checked when
  confirmed intentional.
- [ ] **Inventory / docs line reconciled at closeout** — add a `tool_batch_end`
  row to the events table in `docs/EXTENSIONS.md:236-250` (after the `tool_end`
  row at `:248`) and add it to the events list in the README diagram/prose
  (`README.md:154-159`). `CLAUDE.md` has no hook-surface events enumeration to
  reconcile (the Hook-bus row in the Architecture table and the per-extension
  filter-hook mentions under "House conventions" do not list lifecycle events),
  so it needs no change here. At closeout, reconcile that the documented event
  set (`docs/EXTENSIONS.md`, `README.md`), the `KernelEvents` keys in
  `src/kernel/events.ts`, and this design all list the same events.

## 3. Scope Boundary (NON-goals — Simplicity First)

This is deliberately the smallest possible change. Explicit non-goals:

- **No new filter hook.** `tool_batch_end` cannot veto, rewrite, or delay
  anything. The veto seam already exists per-call (`beforeToolCall`,
  `src/kernel/events.ts:54-58`). A wave-level intervention point is out of scope.
- **No extension file.** There is no `src/extensions/tool-batch-end.ts`. The
  kernel emits; consumers are future extensions written independently.
- **No host wiring, no builtin set change, no command, no capability, no env
  kill switch.** A notification with no consumers is inert; none of these are
  warranted (see Deliverables N/A items).
- **No behavior change.** `tool_end`, `turn_end`, `message`, `usage`, and the
  ordering/termination logic (`src/kernel/agent.ts:205-224`) fire exactly as
  before. This event is appended to the stream, changing nothing else.
- **No payload beyond the settled wave.** No timing data, no per-tool durations,
  no wave index/counter, no error rollup, no "is parallel vs sequential" flag.
  Consumers derive everything they need from the `{call, result}` pairs (e.g.
  `result.isError`, `batch.length`). Speculative fields are out of scope.
- **No change to the public *value* surface.** No new runtime export is added to
  `src/kernel/index.ts`; `KernelEvents` is a type re-exported via
  `export * from "./events.js"` (`src/kernel/index.ts:11`) and does not appear in
  `Object.keys(kernel)`, so `EXPECTED_EXPORTS`
  (`test/kernel-surface.test.ts:21-47`) is **not** touched.

## 4. Key Design Decisions

### D1 — Notification event vs filter hook

- **Problem:** what *kind* of hook marks a settled wave — an observe-only
  notification (`on`/`emit`) or an intervene filter (`filter`/`apply`)?
- **Options:** (a) a `KernelEvents` notification; (b) a `KernelFilters` filter
  threading the `DispatchOutcome[]` through handlers so a consumer could rewrite
  or veto post-hoc.
- **Choice:** a notification event in `KernelEvents` (`src/kernel/events.ts:11-38`).
- **Rationale:** the stated use cases (incremental typecheck, secrets sweep,
  cost rollup) are all *observation*. The wave has already executed by the time
  the group resolves — there is nothing left to veto, so an intervene hook would
  be a misleading API.
- **Why (b) rejected:** a post-execution filter that "vetoes" is incoherent
  (the side effects already happened) and would invite consumers to mutate
  already-appended results, breaking the ordering contract
  (`src/kernel/agent.ts:206-216`). Per-call interception is already covered by
  `beforeToolCall`/`afterToolCall` (`src/kernel/events.ts:54-63`); duplicating
  that at wave granularity adds surface for no capability.

### D2 — Payload shape: `{ batch: {call,result}[] }` vs `{ calls, results }`

- **Problem:** how to carry the ordered wave to consumers.
- **Options:** (a) parallel arrays `{ calls: ToolCallBlock[]; results: ToolResult[] }`;
  (b) an array of pairs `{ batch: { call: ToolCallBlock; result: ToolResult }[] }`.
- **Choice:** (b), the array of `{ call, result }` pairs.
- **Rationale (this is a format choice, justified for consistency):** the
  existing `tool_end` payload is `{ call: ToolCallBlock; result: ToolResult }`
  (`src/kernel/events.ts:32`), and `dispatch()` already returns exactly this
  pair shape as `DispatchOutcome` (`src/kernel/agent.ts:367-370`). Wrapping the
  returned array as `{ batch }` means the emit site is a near-identity map of
  `results` and a consumer's element destructure (`{ call, result }`) is
  *identical* to a `tool_end` handler — one mental model for both events.
- **Why (a) rejected:** parallel arrays force consumers to index two arrays in
  lockstep and re-establish the `calls[i] ↔ results[i]` invariant by hand,
  which is exactly the pairing `DispatchOutcome` already guarantees. It also
  diverges from the `tool_end` field shape, so the two events would read
  differently for no benefit.

### D3 — Emit for every dispatch group vs only multi-tool waves

- **Problem:** should a single-tool wave fire `tool_batch_end`?
- **Options:** (a) emit for every `dispatch()` group, including a wave of one;
  (b) emit only when `calls.length > 1`.
- **Choice:** (a) — emit for every group.
- **Rationale:** `dispatch()` is called once per tool-bearing turn regardless of
  count (`src/kernel/agent.ts:205`); a single-tool turn is simply a wave of one.
  Emitting unconditionally keeps the emit site branch-free and the contract
  uniform ("once per dispatch group, always"). A consumer that only cares about
  multi-tool waves filters on `batch.length > 1` in one line.
- **Why (b) rejected:** a length gate puts policy in the kernel ("a wave of one
  doesn't count"), which is an opinion the core should not hold. It also makes
  the event's firing conditional and harder to reason about, and would silently
  drop the event for the common single-tool case where a cost-rollup consumer
  still wants it.

### D4 — Emit timing within the turn

- **Problem:** where in `Agent.run` does the emit go relative to the
  result-message append, `message`, and `turn_end`?
- **Options:** (a) after `dispatch()` resolves but **before** the `tool` message
  append (`src/kernel/agent.ts:206-217`); (b) after the `tool` message append /
  `message` emit; (c) folded into `runOne` after the last tool.
- **Choice:** (a) — immediately after `const results = await this.dispatch(calls)`
  (`src/kernel/agent.ts:205`), before building/appending `toolMessage`
  (`src/kernel/agent.ts:206-218`) and before `turn_end`
  (`src/kernel/agent.ts:219`).
- **Rationale:** this is the one point where the full, ordered wave exists as a
  single in-memory value (`results: DispatchOutcome[]`) and nothing downstream
  has yet committed it to the transcript. A consumer observes the settled wave
  as a unit, in order, before the turn closes.
- **Why (b) rejected:** placing it after the `message` emit reorders the natural
  narrative (results visible to `message` observers before the wave-settled
  signal) and gains nothing. **Why (c) rejected:** `runOne` runs per-tool
  (`src/kernel/agent.ts:301-312`) and has no visibility into the whole group;
  detecting "last tool of the wave" there would require threading wave size into
  `runOne`, adding state and a branch to the hot path for no benefit.

### D5 — Zero behavior change vs reusing/renaming existing events

- **Problem:** could the need be met by changing an existing event instead of
  adding one?
- **Options:** (a) add `tool_batch_end` as a strictly additive event, leaving
  all existing events firing identically; (b) repurpose `turn_end` to also carry
  the wave; (c) batch `tool_end` into a single end-of-wave emit.
- **Choice:** (a) — strictly additive.
- **Rationale:** `turn_end` fires once per *turn* including pure-text turns with
  no tools (`src/kernel/agent.ts:197,201`), and `tool_end` is a per-*tool*
  contract that existing consumers (e.g. journal, renderers) depend on firing N
  times. The wave boundary is a distinct concept; it deserves its own name.
- **Why (b) rejected:** overloading `turn_end`'s payload changes a stable
  event's shape and would fire wave data on tool-less turns where there is no
  wave. **Why (c) rejected:** collapsing `tool_end` into one emit is a breaking
  behavior change — it would starve every existing per-tool observer of N−1
  events, violating the "zero behavior change" constraint outright.

### D6 — Stay under the kernel line ceiling

- **Problem:** the minimalism guard caps kernel source
  (`test/kernel-surface.test.ts:59-69`, ceiling 2200 lines); does this addition
  fit?
- **Options:** (a) add the event inline to `events.ts` + one emit in `agent.ts`;
  (b) introduce a helper/abstraction to "centralize" wave emission.
- **Choice:** (a) — inline. Current kernel is **1768 lines** (measured), leaving
  **432 lines** of headroom; this change adds ~1 line to `events.ts`
  (`src/kernel/events.ts:32-33`) and ~2 lines to `agent.ts`
  (`src/kernel/agent.ts:205-206`), well under the cap.
- **Why (b) rejected:** a helper for a single two-line emit is speculative
  abstraction that *grows* the core to "save" lines it does not spend, and the
  surface test (`test/kernel-surface.test.ts`) exists precisely to discourage
  that. The inline addition keeps the diff auditable and the ceiling green.

## 5. Dependencies and Assumptions

- **Depends on** the existing `HookBus.emit` notification path
  (`src/kernel/hooks.ts:50-61`), which iterates handlers in registration order
  and **isolates handler errors** (`src/kernel/hooks.ts:54-60` — try/catch →
  `reportHandlerError`), so a throwing consumer cannot break the loop. No change
  to `HookBus` is required.
- **Depends on** `dispatch()` returning ordered `{call, result}` pairs
  (`src/kernel/agent.ts:288-299`, `DispatchOutcome` at `:367-370`). The ordering
  guarantee is already covered by `test/agent.test.ts:33-58`.
- **Depends on** `ToolCallBlock` and `ToolResult` types
  (`src/kernel/types.ts:21`, `:128`), already imported into `events.ts`
  (`src/kernel/events.ts:9`) — no new imports needed.
- **Assumes** offline testability via `makeHarness` + `MockProvider`
  (`test/helpers.ts:27-45`); the new test scripts a multi-tool responder exactly
  as `test/agent.test.ts:33-58` does. No network, no API key.
- **Assumes** strict TS conventions hold: ESM `.js` specifiers, no `any`,
  `noUncheckedIndexedAccess`. The payload maps `results` with a typed callback,
  no index access, so it compiles clean under `npm run typecheck`.
- **Assumes** the event fires only on tool-bearing turns: when `calls.length === 0`
  the loop returns before `dispatch()` (`src/kernel/agent.ts:194-203`), so
  `tool_batch_end` correctly does not fire on pure-text turns.

## 6. Relationship with Existing Designs

- **Closest kernel surfaces this extends/touches:**
  - `src/kernel/events.ts:11-38` — the `KernelEvents` map this adds one key to.
  - `src/kernel/agent.ts:205-219` — the `dispatch()` call site and the
    `turn_end`/message-append region; the single emit lands at `:205-206`.
  - `src/kernel/agent.ts:288-299` (`dispatch`) and `:301-312` (`runOne`, which
    emits the per-tool `tool_end` at `:310`) — the granularity this event sits
    *above*.
  - `src/kernel/hooks.ts:50-61` (`HookBus.emit`) — the error-isolated path this
    reuses unchanged.
- **De-duplication (verified absent):** `turn_end` fires once per **turn** —
  including a model text turn that ran no tools (`src/kernel/agent.ts:197,201`) —
  and `tool_end` fires once per **tool** (`src/kernel/agent.ts:310`). **Neither**
  marks the boundary of a single parallel dispatch **group**. There is no
  existing event between "a tool finished" and "the turn ended". Confirmed by
  reading `src/kernel/agent.ts` end-to-end and the `KernelEvents` map
  (`src/kernel/events.ts:11-38`): no wave-scoped notification exists.
- **Consumers this enables (not part of this change):** the spec's example
  checks — incremental typecheck after an edit wave, once-per-wave secrets
  sweep, per-wave cost rollup — would be ordinary extensions subscribing via
  `e.on("tool_batch_end", ...)`, paralleling how `recovery`/`integrity`/cost
  extensions already attach to existing events. No conflict: none of them
  currently subscribes to a wave event because none exists.
- **First-design note:** there is no prior design doc for a wave/batch lifecycle
  event in `docs/design/`. This is the first design introducing the
  `tool_batch_end` seam.

## 7. Acceptance Criteria

Each criterion is a runnable assertion against the offline harness
(`test/helpers.ts`) or a grep/typecheck; all must pass.

1. **Type exists, compiles:** `npm run typecheck` passes with
   `tool_batch_end: { batch: { call: ToolCallBlock; result: ToolResult }[] }`
   present in `KernelEvents` (`src/kernel/events.ts`). A consumer
   `agent.hooks.on("tool_batch_end", ({ batch }) => ...)` type-checks with
   `batch` inferred as the pair array (no cast).
2. **Exactly one per 3-tool wave:** in a run where the responder requests a
   parallel wave of 3 tools (per `test/agent.test.ts:33-58` pattern), a counter
   incremented in an `on("tool_batch_end")` handler equals **1**:
   `assert.equal(batchEvents.length, 1)`.
3. **Ordered pairs:** the single event's `batch` length is 3 and its
   `batch.map((p) => p.call.id)` equals the requested order
   (`assert.deepEqual(order, ["c1","c2","c3"])`), mirroring
   `test/agent.test.ts:55-57`.
4. **Per-tool events unchanged:** in the same run, a `tool_end` counter equals
   **3** (`assert.equal(toolEndCount, 3)`) — the wave event does not replace or
   suppress per-tool emits.
5. **Turn event unchanged:** in the same run, `turn_end` still fires
   (`assert.equal(turnEndCount, 1)` for the single tool-then-text run shape).
6. **Single-tool wave still emits:** a run with a one-tool wave produces exactly
   one `tool_batch_end` whose `batch.length === 1`
   (`assert.equal(batchEvents[0].batch.length, 1)`).
7. **Throwing consumer does not break the loop:** with
   `setHandlerErrorReporter(() => {})` and an `on("tool_batch_end")` handler that
   throws, the run still completes with the expected `reason` and final text
   (reuses the isolation guarantee tested at `test/hooks.test.ts:23-36`).
8. **Surface ceiling green:** `test/kernel-surface.test.ts` still passes — the
   kernel line count stays `< 2200` and `EXPECTED_EXPORTS`
   (`test/kernel-surface.test.ts:21-47`) is unchanged (no new runtime export).
9. **Docs reconciled:** `grep -c tool_batch_end docs/EXTENSIONS.md` ≥ 1 and
   `grep -c tool_batch_end README.md` ≥ 1; the documented event set
   (`docs/EXTENSIONS.md`, `README.md`) matches the `KernelEvents` keys in
   `src/kernel/events.ts`. (`CLAUDE.md` carries no lifecycle-events
   enumeration, so it is out of scope for this reconciliation.)

## 8. Risks and Rollback

- **Risk: kernel-surface growth.** Any new kernel event enlarges the core's
  contract. *Mitigation:* the change is additive and observe-only (~3 lines
  total, D6), adds **no** runtime export so the export-list portion of
  `test/kernel-surface.test.ts` is untouched, and AC#8 pins the line ceiling.
- **Risk: a consumer throws inside the new handler and breaks the loop.**
  *Mitigation:* `HookBus.emit` already wraps each handler in try/catch and
  routes errors to `reportHandlerError` without rethrowing
  (`src/kernel/hooks.ts:54-60`) — **confirmed by reading the source**. The emit
  cannot propagate a handler error out of `Agent.run`. AC#7 asserts this end to
  end.
- **Risk: accidental behavior change (event reordering, double-fire).**
  *Mitigation:* AC#2–#6 assert exactly-once firing and that `tool_end`/`turn_end`
  remain unchanged; the emit is a single statement inserted between
  `dispatch()` and the message append, touching no existing line's logic.
- **Risk: payload divergence from `tool_end`.** *Mitigation:* D2 mirrors the
  `tool_end` `{call, result}` field names; AC#1/#3 lock the shape.
- **Kill switch / rollback:** no env kill switch is added (an event with zero
  consumers is inert — Deliverables N/A). **Rollback is a two-line revert:**
  delete the `tool_batch_end` key from `KernelEvents`
  (`src/kernel/events.ts`) and the single `await this.hooks.emit("tool_batch_end", ...)`
  line in `Agent.run` (`src/kernel/agent.ts:205-206`). No consumer depends on it
  at introduction, so removal is safe and complete; the doc rows are reverted in
  the same commit.
