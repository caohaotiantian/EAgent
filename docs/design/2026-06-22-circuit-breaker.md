# Design: `circuit-breaker` — tool-call repetition / consecutive-failure fail-fast

Slug: `2026-06-22-circuit-breaker`
Status: closed
Closing-commit: 3716179
Closed-on: 2026-06-22
Deferred: none

## 1. Background and Purpose

EAgent already has two run-scoped guards on the tool-dispatch path, but neither
tracks the *identity* of a call:

- `limits` (`src/extensions/limits.ts`) caps the **total** number of tool calls
  and total tokens per run. It increments one counter on every
  `beforeToolCall` (`limits.ts:221`) and blocks when the run-wide budget is
  exceeded (`limits.ts:222-228`). It does not care *which* call ran — a hundred
  distinct, productive calls and a hundred copies of one broken call look
  identical to it.
- `recovery` (`src/extensions/recovery.ts`) appends **one** corrective hint to a
  *failed* result via `afterToolCall` (`recovery.ts:94-100`). It is a single
  post-processing nudge with **no state** — it cannot tell whether the model
  ignored the same hint five turns in a row.

So three failure modes slip through both guards:

1. **Identical broken retry.** The model re-issues a byte-for-byte identical call
   that failed — ignoring `recovery`'s nudge — and burns the whole `limits`
   budget one wasted turn at a time. `recovery` already conceded this is the
   common reflex ("the model's common reflex is to re-issue the same broken
   call", `recovery.ts:6-7`).
2. **Useless-but-successful spin.** A call that *succeeds* every time with the
   same arguments yet makes no progress (a poll that never advances, a re-list of
   the same directory). `recovery` never fires (it gates on `isError`,
   `recovery.ts:95`); `limits` only notices at the global cap.
3. **A-B-A oscillation.** The model alternates between two calls, neither of
   which is *consecutively* repeated, so a naive "same call twice in a row"
   detector misses it entirely.

What these share is a **per-signature** loop whose correction is mechanical. The
right primitive is a circuit breaker keyed on the call signature that trips fast
— softly first (a steer), then hard (ask/block) — rather than letting the run
drain its budget.

What happens if we do not build it: a looping or adversarial model spends the
entire `limits` budget (default `maxToolCallsPerRun = 100`, `limits.ts:30`) on a
single repeated mistake before anything stops it, and `recovery`'s one-shot hint
is the only correction in the loop.

## 2. Deliverables

- [ ] `src/extensions/circuit-breaker.ts` — a new, standalone extension that
      maintains a per-run `Map<signature, { count; consecutiveFailures }>`, trips
      on the repetition / consecutive-failure ladder via `beforeToolCall`,
      records outcomes via `afterToolCall`, and resets all state on
      `agent_start`.
- [ ] A `/circuit-breaker [on|off|ask|block|status|reset|threshold=<n>]`
      command (command shape mirrors `flow-guard`, `flow-guard.ts:191-231`).
- [ ] On-by-default gating via `e.store` (`enabled` default `true`,
      `threshold` default `3`, `mode` default `ask`) plus an
      `EAGENT_CIRCUIT_BREAKER=off` hard kill switch returning a no-op disposer
      (mirrors `recovery.ts:103`).
- [ ] Registration in `src/host.ts` `BUILTIN_EXTENSIONS` (append after
      `write-guard`/`content-guard`, `host.ts:62-93`).
- [ ] `test/circuit-breaker.test.ts` — offline `node:test` suite against a
      scripted `MockProvider` + an inline stub tool via `makeHarness`
      (`test/helpers.ts:27`), covering every Acceptance Criterion in §7.
- [ ] One inventory line in `CLAUDE.md` "Where things live" and one row in the
      README "Built-in extensions" table (`README.md:192-223`), **and** the
      `src/extensions/  N built-in extensions` count at `README.md:323` bumped
      from `30` to `31` — reconciled at closeout.

## 3. Scope Boundary (explicit NON-goals — Simplicity First)

- **Not folded into `limits`.** This is a separate extension file (see D1). We do
  not touch `limits.ts`.
- **No semantic similarity.** The signature is an *exact* match on
  name + canonical args. "Almost identical" calls (one differing field, fuzzy
  argument distance) are intentionally **not** detected — that is `risk-guard`'s
  province, not a mechanical breaker's.
- **No cross-run / persistent state.** The breaker's Map is in-memory and reset
  on `agent_start`, exactly like `limits`'s counters (`limits.ts:200-203`). It
  does **not** remember a loop from a previous run, and nothing is written to
  `e.store` except the three config keys.
- **No per-tool allowlist / exclusion list.** Every tool is subject to the same
  threshold. (A poll that *legitimately* repeats with identical args is handled
  by the conservative default N and the `ask` escape, not by a curated exclusion
  list — see §8.)
- **No argument rewriting / auto-correction.** The breaker only steers, asks, or
  blocks. It never mutates `decision.arguments` (unlike a guard that coerces
  input). The kernel re-validates rewritten args (`agent.ts:338`); we have
  nothing to rewrite.
- **No new capability.** It only blocks/steers; it performs no side effect of its
  own (see D-rationale in §4 and the "Capability" note in §6).
- **No back-off timers / half-open probing.** A classic electrical circuit
  breaker has a cool-down + half-open retry. We have no wall-clock loop to probe;
  "reset" happens at `agent_start` or via `/circuit-breaker reset`. Time-based
  half-open is explicitly out of scope.

## 4. Key Design Decisions

### D1 — Separate extension vs. fold into `limits`

**Problem.** The breaker is another run-scoped, `beforeToolCall`-gated counter
that resets on `agent_start` — structurally the twin of `limits`'s tool-call
budget. Do we add it as a third counter inside `limits.ts`, or ship a new file?

**Options.**
- (a) Fold it into `limits.ts`: reuse the existing `agent_start` reset
  (`limits.ts:200-203`), the existing `beforeToolCall` gate (`limits.ts:210`),
  and the `/limits` command.
- (b) A new, standalone `src/extensions/circuit-breaker.ts`.

**Choice: (b), separate extension.**

**Rationale.** EAgent's house architecture is "everything else is an extension"
and each guard is its own single file with its own kill switch, command, and
tests — `flow-guard`, `risk-guard`, `bash-policy`, `write-guard`, `recovery` are
all separate files on the *same* `beforeToolCall`/`afterToolCall` seams. Folding
would (i) bloat `limits.ts` (already 350 lines doing output truncation + spill +
call/token budgets) with an orthogonal concern, (ii) entangle two kill switches
(`EAGENT_TOOL_SPILL` vs. a breaker switch) and two command surfaces, and (iii)
make the breaker un-removable without also losing the budget guard. A separate
file trivially reuses the *pattern* — an `agent_start` reset of an in-memory
counter (copied, not shared, from `limits.ts:200-203`) — without coupling the
code.

**Why (a) rejected.** It violates the one-guard-one-extension convention, couples
two independently-useful guards into one disposer, and grows a file that is
already at the limit of one clear responsibility. The only thing (a) "saves" is a
second `agent_start` handler — a three-line cost — which is not worth the
coupling.

### D2 — Signature = `name + stableStringify(sortedArgs)` vs. name-only

**Problem.** What counts as "the same call"? The breaker must group calls into
buckets to detect repetition.

**Options.**
- (a) `name`-only: bucket by tool name.
- (b) `name + JSON.stringify(args)`: bucket by name and the raw argument JSON.
- (c) `name + stableStringify(args)`: bucket by name and a **canonical**
  serialization where object keys are recursively sorted, so
  `{a:1,b:2}` and `{b:2,a:1}` hash to the same string.

**Choice: (c).**

**Rationale.** A loop is "the *same* call repeated", and "same" means same tool
*and* same arguments. Option (c) makes `{a,b}` and `{b,a}` collapse to one
bucket, because providers do not guarantee a stable key order across turns — two
genuinely-identical calls must not land in different buckets and dodge the
breaker. Both hooks key on the **raw model arguments** (`ctx.call.arguments`),
not the validate-coerced `decision.arguments`: `afterToolCall` only sees
`ctx.call`, so keying `beforeToolCall` on the coerced shape (`"3"`→`3`, filled
defaults) for any coercing schema would split the occurrence count and the
failure streak across two buckets and silently defeat detection. Hashing
`ctx.call.arguments` in both hooks keeps a single bucket per call.

**Why (a) rejected.** Name-only trips on *legitimately different* calls — reading
ten different files with `read` would trip after three reads, which is normal
productive work, not a loop. Catastrophic false-positive rate.

**Why (b) rejected.** Raw `JSON.stringify` is key-order-sensitive: the same call
emitted with `{path,offset}` one turn and `{offset,path}` the next produces two
distinct strings and silently defeats detection. Sorting keys (c) is a small,
non-behavioral string-canonicalization detail layered on top of (b); it is the
strictly-safer serialization with no downside. (The stable-stringify *format*
itself is a pure serialization choice and self-justifies as non-behavioral; the
*decision* here is name+args vs. name-only, which is behavioral and chooses (c).)

### D3 — Count TOTAL occurrences-in-run vs. strictly-consecutive identical

**Problem.** When the breaker counts repetitions of a signature, does it require
the repeats to be *consecutive*, or count every occurrence anywhere in the run?

**Options.**
- (a) Strictly-consecutive: reset a signature's count whenever a *different*
  signature runs in between.
- (b) Total-in-run: increment a signature's count on every occurrence; reset only
  on `agent_start` (or `/circuit-breaker reset`).

**Choice: (b), total occurrences in the run.**

**Rationale.** A-B-A-B oscillation (failure mode #3) is exactly the case where
the repeats are *not* consecutive. Strictly-consecutive counting resets A's
counter every time B runs, so an A-B-A-B-A-B loop never trips even as it drains
the budget. Total-in-run counting catches both the simple "AAA" repeat and the
oscillation, with the same single `Map` increment. Reset only at `agent_start`
keeps the bucket meaningful for the *whole* run — the budget is "this run", not
"this streak".

**Why (a) rejected.** It is blind to oscillation — the single most adversarial
loop shape — and buys nothing: the repetition count is meaningful per-run, and
there is no scenario where an intervening *different* call makes a re-issued
identical call suddenly benign. (Note: the **consecutive-failure** counter is
separate and *does* reset on a success of that signature — see Hooks in §5. The
*occurrence* count never resets mid-run; the *failure streak* does.)

### D4 — Threshold N default = 3 (threshold decision)

**Problem.** At how many occurrences (or consecutive failures) of a signature
does the breaker hard-trip?

**Options.** N = 2, N = 3, N = 5.

**Choice: N = 3 (configurable via `e.store`, like every `limits` cap).**

**Rationale.** The intervention ladder reads naturally at N = 3: the **1st**
occurrence is the legitimate call; the **2nd** is a retry (often legitimate — a
transient error, an idempotent re-try) and earns only a *soft, non-blocking
steer* (see D5); the **3rd** is a confirmed pattern and earns the hard stop. N=3
is conservative on purpose: it never hard-trips on a single retry, which keeps it
safe to ship on-by-default (D6). It mirrors `limits`' philosophy of a tunable
positive-integer cap with a sane default (`limits.ts:30,88-94`).

**Why N = 2 rejected.** A single legitimate retry of a transient failure (or an
intentionally idempotent re-run) would hard-trip on the 2nd call. Too eager;
would generate false halts on normal retry behavior and make the extension feel
hostile.

**Why N = 5 rejected.** By the 5th identical wasted call the model has already
burned five turns/tokens on a confirmed loop — the whole point is to fail
*fast*. N=5 defers the hard stop past the moment the pattern is unambiguous (at
the 3rd). N stays user-tunable for anyone who wants 5.

### D5 — Escalation ladder: soft-steer-first vs. hard-stop-on-first-repeat

**Problem.** When a signature repeats, what is the *first* intervention?

**Options.**
- (a) Hard-stop on the first detected repeat (block/ask immediately at the 2nd
  occurrence).
- (b) Soft-first ladder: at the **2nd** occurrence, inject one non-blocking
  `e.agent.handle.steer(...)` nudge telling the model it is repeating an
  identical call; only at the **N-th** occurrence (or N consecutive failures)
  escalate to ask (`block` if denied) / block.

**Choice: (b), soft-steer-first.**

**Rationale.** `steer` pushes a message that the loop drains *before the next
turn* (`agent.ts:122-124`, drained at `agent.ts:173`) — a pure, non-blocking
correction that costs nothing and lets a model that simply forgot self-correct,
exactly the affordance `recovery` provides but keyed to *repetition* instead of a
*failure string*. Holding the hard stop until N preserves legitimate retries and
idempotent re-tries (a `write` re-run after a transient failure, a poll that the
operator expects). The ladder degrades gracefully: nudge → ask/kill-switch escape
→ block.

**Why (a) rejected.** A hard stop on the first repeat would kill legitimate
retries and idempotent re-tries — the very behavior D4's conservative N exists to
protect. It also discards the cheap, effective correction (`steer`) entirely,
making the breaker strictly more disruptive than `recovery` for no benefit.

### D6 — Posture: on-by-default `mode=ask` vs. off-by-default

**Problem.** Is the extension active out of the box, or opt-in?

**Options.**
- (a) On by default, `mode=ask`.
- (b) Off by default (opt-in, like `risk-guard`, `README.md:219`).

**Choice: (a), on by default, `mode=ask`.**

**Rationale.** The *first* intervention is a non-blocking steer (D5) — it cannot
abort a run, it only adds one corrective message — so being on by default is
safe. The hard halt only fires at N, and even then `ask` mode routes through
`e.agent.ui.confirm` so a human can allow it (`flow-guard.ts:178`,
`write-guard.ts:85`), with `EAGENT_CIRCUIT_BREAKER=off` as a hard escape. This is
the same posture `recovery` and `limits` ship with — both on by default, because
a runaway-loop guard that is off by default protects no one. `risk-guard` is
off-by-default because it makes an *extra model call* on every sensitive
invocation (cost + latency); the breaker makes *no* model call, so that argument
does not apply.

**Why (b) rejected.** Off-by-default would mean the most common, cheapest-to-stop
failure (a model spinning on one broken call) is unprotected unless a user knows
to enable it. The cost that justifies `risk-guard`'s opt-in posture (a provider
sub-call per check) is absent here, so there is nothing to amortize and no reason
to default off.

## 5. Dependencies and Assumptions

**Dependencies (all kernel-public, all already used by the cited extensions):**

- `e.hook("beforeToolCall", …)` — filter returning a `ToolDecision`
  (`events.ts:41-46,55-58`). Applied at `agent.ts:318-323`; `decision.block`
  short-circuits later guards via the `(d) => d.block` predicate
  (`agent.ts:322`), and a blocked call becomes `Tool call blocked: <reason>` with
  `isError:true` (`agent.ts:324-325`). The breaker reads `ctx.call` (name + id +
  raw `arguments`) and keys on `ctx.call.arguments` (D2).
- `e.hook("afterToolCall", …)` — filter receiving the `ToolResult` and
  `{ call }` context (`events.ts:60-63`), applied at `agent.ts:303`. The breaker
  reads `result.isError` and `ctx.call` to update the consecutive-failure streak,
  and returns the result **unchanged** (it only observes here).
- `e.on("agent_start", …)` — fired once per run at `agent.ts:156`, before any
  tool dispatch. Used to clear the per-run Map (same lifecycle `limits` uses,
  `limits.ts:200-203`).
- `e.agent.handle.steer(message)` — takes a full `Message` (`agent.ts:117-119`,
  `types.ts` `AgentHandle.steer(message: Message): void`), drained into the
  transcript before the next turn (`agent.ts:173`).
- `e.agent.ui.confirm(prompt)` — the human gate for `ask` mode
  (`agent.ts:67` exposes `ui`; reached as `e.agent.ui.confirm`, exactly as
  `flow-guard.ts:178` / `write-guard.ts:85` / `risk-guard.ts:137` do).
- `e.store.get/set` — three config keys (`enabled`, `threshold`, `mode`), read
  defensively like `flow-guard.ts:75-87` and `limits.ts:88-122`.
- `e.registerCommand` — the `/circuit-breaker` command (`flow-guard.ts:191`).
- Zero new runtime dependencies; pure Node, strict TS, `.js` import specifiers.

**Assumptions:**

- A `beforeToolCall` filter runs **once per tool call**, before `executeGuarded`
  dispatches — so incrementing the occurrence count there counts every attempt,
  including ones a *later* guard blocks. (Acceptable: a call another guard blocks
  did not loop productively either; counting it is conservative, not wrong.) If a
  prior guard already set `decision.block`, the breaker passes the decision
  through untouched — matching `limits.ts:212` (`if (decision.block) return
  decision`).
- `ctx.call.name` plus `ctx.call.arguments` (the raw model arguments, keyed the
  same way in both hooks — D2) fully determine the call's identity for
  loop-detection purposes. Arguments are JSON-serializable (they came from
  the model as JSON, `agent.ts:314`).
- `steer` injecting a message does **not** re-enter `beforeToolCall` (it is a
  user/system message, not a tool call), so the soft nudge cannot itself trip the
  breaker — no recursion risk.
- The breaker fails **open**: every hook body is wrapped in `try/catch` that logs
  via `e.log.warn` and returns the decision/result unchanged on any internal
  error (the `limits.ts:230-233` posture), so a breaker bug never aborts the run.

## 6. Relationship with Existing Designs

**Closest existing extensions (all read and cited above):**

- **`limits` (`src/extensions/limits.ts`)** — the structural twin: per-run
  counter reset on `agent_start` (`limits.ts:200-203`), a `beforeToolCall` gate
  that returns `{ ...decision, block:true, reason }` (`limits.ts:210-234`), a
  positive-integer `e.store` config with defaults (`limits.ts:88-137`), a slash
  command (`limits.ts:237`), and fail-open `try/catch` wrapping
  (`limits.ts:230-233`). The breaker copies this *shape*. **Dedup:** `limits`
  counts **totals** with no notion of call identity; the breaker buckets by
  **signature**. They are complementary on the same seam, and order between them
  does not matter: each guard honors an already-set `decision.block` and the chain
  short-circuits on the first block via the `(d) => d.block` predicate
  (`agent.ts:322`, `hooks.ts:104`). (For the record, `circuit-breaker` registers
  just after `content-guard`, *before* `limits`, in `BUILTIN_EXTENSIONS`.) The
  breaker trips chronologically earlier, at N=3, long before `limits`' total-100
  cap. Neither subsumes the other.

- **`recovery` (`src/extensions/recovery.ts`)** — the complement this builds on:
  it nudges **once** on a *failed* result (`recovery.ts:94-100`) with **no
  repetition tracking**, and demonstrates the kill-switch no-op-disposer pattern
  (`recovery.ts:103`). **Dedup:** `recovery` keys on the *error string* of a
  single failure and never blocks; the breaker keys on the *repeated signature*
  (success or failure) and escalates to block. The breaker is what catches the
  model that *ignores* `recovery`'s hint and re-issues the identical call.

- **`flow-guard` (`src/extensions/flow-guard.ts`)** — the ask/block-mode +
  command template: `mode: "ask" | "block"` (`flow-guard.ts:31`), the
  `EAGENT_*=off` + store-`enabled` config (`flow-guard.ts:75-87`), the
  `e.agent.ui.confirm` gate (`flow-guard.ts:178`), and the
  `/[on|off|ask|block|reset|status]` command shape (`flow-guard.ts:191-231`).
  The breaker copies the **command and mode vocabulary**. **Dedup:** `flow-guard`
  gates *egress after a tainting capability/data* (a compositional/dataflow
  check); the breaker gates *repetition* (a frequency check). Disjoint triggers.

**Capability note.** Like `recovery`, `flow-guard`, `bash-policy`, and
`write-guard`, the breaker declares **no capability** — it registers no tool and
performs no side effect of its own; it only steers/blocks the decision the kernel
already authorizes. House rule: "every extension is capability-gated *where it has
side effects*" (CLAUDE.md) — this one has none.

**Conflicts:** none. The breaker shares the `beforeToolCall` / `afterToolCall` /
`agent_start` seams with `limits`, `recovery`, `flow-guard`, and the other
guards, but the hook bus runs them in registration order and each is independent
(an earlier `block` short-circuits the rest via `agent.ts:322`); the breaker
respects an existing `decision.block` and never un-blocks. No first-design note —
this slots into a well-established family of run-scoped guards.

## 7. Acceptance Criteria

All criteria are runnable assertions in `test/circuit-breaker.test.ts` against
`makeHarness` (`test/helpers.ts:27`) with a scripted `MockProvider` and an inline
stub tool registered via `e.registerTool`. The MockProvider scripts the assistant
to emit identical / oscillating / failing tool calls; assertions inspect the
transcript (`agent.messages`), the stub tool's invocation count, and command
output.

1. **Soft steer at the 2nd occurrence (non-blocking).** Script the same call
   (same name+args) twice. Assert: the stub tool executes **both** times (count
   == 2, i.e. not blocked), and after the 2nd a steer message containing
   `circuit-breaker` and "repeating"/"identical" is present in the transcript
   before the next turn. No `Tool call blocked` result yet.

2. **Hard trip at N (default 3), `mode=block`.** Set `mode=block`. Script the
   identical call three times. Assert: the stub executes **twice** (1st, 2nd) and
   the 3rd produces a `tool_result` with `isError === true` whose content matches
   `circuit-breaker: <tool> called 3x with identical args` — and the stub's
   execution count stays at **2** (the 3rd never ran).

3. **A-B-A-B oscillation trips on the repeated signature.** Script
   A, B, A, B (so A occurs on attempts 1 and 3, B on 2 and 4) with threshold 2.
   Assert: A's **3rd** total occurrence is blocked even though A's repeats are not
   consecutive — proving total-in-run counting (D3), not strictly-consecutive.

4. **Consecutive-failure trip.** Script the same signature returning
   `isError:true` N times. Assert: the N-th attempt is blocked with content
   matching `failed 3x` (the failure-streak branch), distinct from the identical-
   args branch.

5. **Failure streak resets on a success of that signature.** Script the same
   signature: fail, fail, **succeed**, fail, fail (threshold 3 on the
   consecutive-failure branch). Assert: no block fires, because the success reset
   the streak to 0 (the breaker counts *consecutive* failures, reset on success
   per the `afterToolCall` handler).

6. **`ask` mode allows on confirm, blocks on deny.** Set `mode=ask`. With
   `makeHarness({ ui: autoUI(true) })` the N-th call **runs** (confirmed); with
   `autoUI(false)` the N-th call is **blocked** with the breaker reason. (Mirrors
   `flow-guard` ask-mode tests; `autoUI` is `test/helpers.ts:16`.)

7. **Reset on `agent_start`.** Run the same call to one-below-N, finish the run,
   start a **second** `agent.run`, and issue the same call again. Assert: the
   second run starts the count at 0 — the first call of run 2 is **not** blocked
   — proving per-run state (no cross-run carryover).

8. **Distinct signatures never trip.** Script N distinct calls (same tool, each
   with different args — the "advancing pagination" case). Assert: all execute,
   none blocked, no steer — proving D2 (name+args, not name-only).

9. **Stable-stringify collapses key order.** Issue the same call as
   `{a:1,b:2}` then `{b:2,a:1}` then `{a:1,b:2}` with threshold 3. Assert: the
   3rd is treated as the same signature and trips — proving sorted-key
   canonicalization.

10. **Kill switch returns a no-op disposer.** With `EAGENT_CIRCUIT_BREAKER=off`,
    activate and issue the same call 5× with `mode=block`. Assert: **all 5**
    execute, no steer, no block, and the activation returned a disposer that runs
    without throwing. (Mirrors `recovery.ts:103`.)

11. **`enabled=false` via store disables interventions** but the extension stays
    loaded (steer/block suppressed; command still works).

12. **Fail-open on internal error.** Force the signature/serialize step to throw
    (e.g. inject a value that breaks stringify in a unit-level test of the
    hashing helper, or stub it) and assert the `beforeToolCall` hook returns the
    decision unchanged and the run completes — never aborts (`limits.ts:230-233`
    posture).

13. **Command surface.** `/circuit-breaker status` prints `enabled`, `mode`,
    `threshold`, and current bucket count; `off`/`on` toggle `enabled` in the
    store; `ask`/`block` set `mode`; `threshold=4` sets `threshold` to 4 (and
    rejects non-positive); `reset` clears the live Map. Each asserted by invoking
    the command and checking persisted store value + printed output.

14. **Registration / inventory reconciliation.** A test (or CI doc-check) asserts
    `circuit-breaker` appears in `BUILTIN_EXTENSIONS` (`host.ts`), and the README
    extension count line reads `31` (`README.md:323`) with a matching table row.

## 8. Risks and Rollback

**Risk: false trip on legitimate repetition.** Polling that never advances its
arguments, a paginated read whose page token is *not* in the args, idempotent
re-tries after a transient failure — all share a signature and could trip.

*Mitigations:* (1) conservative default N=3 (D4) — a single retry never
hard-trips; (2) soft-steer-first (D5) — the 2nd occurrence only nudges, it does
not block; (3) `mode=ask` default (D6) — a human can allow the N-th call; (4)
`/circuit-breaker threshold=<n>` to raise N or `off` to disable; (5)
`EAGENT_CIRCUIT_BREAKER=off` hard kill switch. Note that **paginated reads with
advancing args have different signatures and never trip** — only truly-identical
calls bucket together (D2/AC-8).

**Risk: counting a call another guard blocks.** `beforeToolCall` increments
before dispatch, so a call vetoed by `flow-guard`/`limits` still counts toward the
breaker's bucket. *Mitigation:* the breaker passes through any
already-`block`ed decision untouched (matching `limits.ts:212`), and a blocked-
then-repeated call is itself a loop worth stopping — counting it is conservative,
not a correctness bug.

**Risk: a breaker bug aborts a run it was meant to protect.** *Mitigation:* every
hook body is wrapped in `try/catch` returning the unchanged decision/result and
logging via `e.log.warn` (the `limits.ts:230-233` fail-open posture); the dispose
loop swallows errors (`limits.ts:297-305`).

**Rollback (in increasing scope, all zero-persistence):**

1. `/circuit-breaker off` — sets `enabled=false` in the store; hooks stay wired
   but no-op.
2. `EAGENT_CIRCUIT_BREAKER=off` — activation returns a no-op disposer; nothing is
   wired at all (`recovery.ts:103` pattern).
3. Unload the extension (`unloadExtension` / hot reload) — the tracked disposers
   tear down every hook and the command cleanly (`extension.ts:218-241`).

Because **all** breaker state is in-memory and reset on `agent_start`, none of
these leaves residue: there is no file, no persistent counter, and the only store
writes are the three reversible config keys.
