# Implementation: `circuit-breaker` — tool-call repetition / consecutive-failure fail-fast

Slug: `2026-06-22-circuit-breaker`
Status: closed
Closing-commit: ae71248
Closed-on: 2026-06-22
Deferred: none
Design doc: `docs/design/2026-06-22-circuit-breaker.md` (PASSED)

This guide drives a fresh agent to TDD-build the `circuit-breaker` extension. It
introduces **no requirement absent from the design** — every task below traces
to a design Deliverable (§2) or Acceptance Criterion (§7). Read the design doc
first; this document only sequences and operationalizes it.

`<TEST-CMD>` (the targeted suite) = `node --import tsx --test test/circuit-breaker.test.ts`.
`<FULL>` = `npm test` (full offline suite). `<TC>` = `npm run typecheck`.

---

## 1. Task Index

Maps each design artifact to the phase task that delivers it. (Tasks are
numbered in §2; T-n = test, I-n = impl, D-n = doc.)

| Design artifact (design §) | Phase task |
| --- | --- |
| **Deliverable** `src/extensions/circuit-breaker.ts` (§2) | I-1 … I-5 |
| **Deliverable** `/circuit-breaker […]` command (§2) | I-4 |
| **Deliverable** on-by-default store gating + `EAGENT_CIRCUIT_BREAKER=off` kill switch (§2) | I-3, I-5 |
| **Deliverable** registration in `host.ts` `BUILTIN_EXTENSIONS` after content-guard (§2) | I-6 |
| **Deliverable** `test/circuit-breaker.test.ts` offline suite (§2) | T-1 … T-11 |
| **Deliverable** `CLAUDE.md` inventory line + README row + count `30`→`31` (§2) | D-1 (closeout) |
| **AC-1** soft steer at 2nd occurrence, non-blocking (§7.1) | T-2 |
| **AC-2** hard trip at N=3, `mode=block` (§7.2) | T-3 |
| **AC-3** A-B-A-B oscillation trips on total count (§7.3) | T-3 (oscillation case) |
| **AC-4** consecutive-failure trip, distinct reason (§7.4) | T-4 |
| **AC-5** failure streak resets on success (§7.5) | T-6 |
| **AC-6** `ask` mode: allow on confirm / block on deny (§7.6) | T-3 (ask variant) |
| **AC-7** reset on `agent_start` (per-run state) (§7.7) | T-7 |
| **AC-8** distinct signatures never trip (§7.8) | T-5 |
| **AC-9** stable-stringify collapses key order (§7.9) | T-1 (unit), T-3 (live) |
| **AC-10** kill switch returns no-op disposer (§7.10) | T-9 |
| **AC-11** `enabled=false` via store suppresses interventions, stays loaded (§7.11) | T-9 (enabled=false case) |
| **AC-12** fail-open on internal error (§7.12) | covered by I-5 fail-open + T-1 unit; see note in §2 |
| **AC-13** command surface (§7.13) | T-11 |
| **AC-14** registration / inventory reconciliation (§7.14) | I-6, D-1 |
| Decision D1 separate extension (§4) | I-1 (new file, no `limits.ts` edit) |
| Decision D2 signature = name+stableStringify(args) (§4) | I-1, T-1 |
| Decision D3 total-in-run count (not consecutive) (§4) | I-2, T-3 (oscillation) |
| Decision D4 threshold default 3 (§4) | I-3 |
| Decision D5 soft-steer-first ladder (§4) | I-2, T-2 |
| Decision D6 on-by-default `mode=ask` (§4) | I-3 |
| `host.unload` removes hooks cleanly (§8 rollback 3) | T-10 |

Note on AC-12: the design (§7.12) accepts unit-level coverage of the hashing
helper *or* a stub. T-1 exercises `stableSignature` directly; the fail-open
`try/catch` it protects is wired in I-5. No separate live "force a throw" task is
mandated by the design beyond this; do not invent additional injection
machinery.

---

## 2. Phase Breakdown

**Single Phase.** This is one self-contained guard extension plus its test and a
one-line host registration — the same shape as the `risk-guard` and `write-guard`
tasks. It is not separable: `<TEST-CMD>` cannot import a half-written module, and
the host registration is a single additive line. Keep it one Phase.

### Phase 1 — the `circuit-breaker` extension

**Entry condition.** L1 design `docs/design/2026-06-22-circuit-breaker.md` is
PASSED (it is). No prior Phase. `npm test` and `npm run typecheck` are green at
HEAD (confirm before starting — that is the regression baseline, see §5).

**Design references.** `docs/design/2026-06-22-circuit-breaker.md` §2
(Deliverables), §3 (NON-goals — read these; they bound the impl), §4 (D1–D6),
§5 (Dependencies — the exact kernel hook surface), §7 (all 14 AC), §8 (fail-open
+ rollback).

#### Module shape to build (`src/extensions/circuit-breaker.ts`)

Mirror `limits.ts` (the structural twin) and `flow-guard.ts` (command/mode
vocabulary). One **exported pure function** so the signature is unit-testable
(mirrors `recovery.ts`'s exported `recoveryHint` / `risk-guard.ts`'s
`parseVerdict`). Everything else is closures inside `activate`.

- `export function stableSignature(name: string, args: unknown): string` —
  **pure**. Returns `name + ":" + stableStringify(args)` where `stableStringify`
  serializes with **recursively sorted object keys**, so `{a:1,b:2}` and
  `{b:2,a:1}` produce the **same** string (D2/AC-9) while different *values*
  produce different strings (so advancing-offset pagination never collides,
  §8/AC-8). Build it with a `JSON.stringify(value, replacer)` whose replacer
  rebuilds plain objects with `Object.keys(v).sort()` (arrays preserved
  in-order; primitives pass through). Strict TS: type the replacer's value as
  `unknown` and narrow — **no `any`**.
- `type Mode = "ask" | "block";`
- `const DEFAULT_THRESHOLD = 3;` (D4). `const DEFAULT_MODE: Mode = "ask";` (D6).
- Per-run state (in-memory, declared once per activation, reset on
  `agent_start` — copied from `limits.ts:200-203`, **not shared**):
  `const buckets = new Map<string, { count: number; consecutiveFailures: number }>();`
  (this is the design's exact data model, design §2 line 50 — no other
  per-run counter). Track the last signature per call id if needed to correlate
  `afterToolCall` with the `beforeToolCall` that preceded it — but prefer
  recomputing the signature from `ctx.call` in `afterToolCall` (the call block
  carries `name` + `arguments`), avoiding extra state.
- `cfg()` — reads each call, defensively (like `limits.ts:88-122` /
  `flow-guard.ts:75-87`):
  - `enabled`: `process.env.EAGENT_CIRCUIT_BREAKER === "off" ? false :
    (e.store.get<boolean>("enabled", true) ?? true)` — **on by default** (D6;
    note default `true`, like `flow-guard`, unlike `risk-guard`'s `false`).
  - `mode`: `e.store.get<Mode>("mode", "ask") ?? "ask"`.
  - `threshold`: a **positive-integer** read (reuse the `limits.ts:88-94`
    `readPositiveInt` shape) defaulting to `3`; reject non-positive/NaN by
    falling back to the default (a safety cap must never silently disable).
- `e.hook("beforeToolCall", (decision, ctx) => { … })` — the ladder:
  1. wrap the whole body in `try/catch` → on throw `e.log.warn(...)` and
     `return decision` (fail-open, §8 / `limits.ts:230-233`).
  2. `const { enabled, mode, threshold } = cfg();`
  3. `if (!enabled || decision.block) return decision;` (kill switch / store
     disable / already-vetoed passthrough — §5 assumption,
     mirrors `limits.ts:212`). **Never un-block** an existing `block`.
  4. `const sig = stableSignature(ctx.call.name, ctx.call.arguments);`
     (hash the **raw model arguments**, exactly as `afterToolCall` does below —
     keying on the validate-coerced `decision.arguments` here would split the
     count and the failure streak across two buckets for any coercing schema,
     since `afterToolCall` only sees `ctx.call`).
  5. Increment the bucket's `count` (total-in-run, D3 — create the bucket if
     absent). This counts every occurrence including ones a later guard blocks
     (§5 assumption — acceptable/conservative).
  6. If `count === 2`: inject the **soft steer** and `return decision`
     (non-blocking, D5/AC-1). Build a `Message`
     (`{ role: "user", content: [{ type: "text", text: msg }] }`) whose `text`
     contains `circuit-breaker` and the words "repeating"/"identical" (AC-1),
     and call `e.agent.handle.steer(message)`. Steer is drained before the next
     turn (`agent.ts:173`) and does **not** re-enter `beforeToolCall` (§5 — no
     recursion).
  7. If `count >= threshold`: this is the hard trip. Compose
     `reason = \`circuit-breaker: ${ctx.call.name} called ${count}x with
     identical args\`` (AC-2 content shape: `circuit-breaker: <tool> called Nx
     with identical args`). In `mode === "block"` →
     `return { ...decision, block: true, reason };`. In `mode === "ask"` →
     `const allow = await e.agent.ui.confirm(...); return allow ? decision :
     { ...decision, block: true, reason };` (AC-6; with no real UI `confirm`
     resolves per the harness `ui`). Note the hook becomes `async` once it
     awaits `confirm` — type it accordingly.
  8. Otherwise `return decision`.
- `e.hook("afterToolCall", (result, ctx) => { … })` — outcome recording
  (observes only; returns `result` **unchanged**, §5):
  1. `try/catch` fail-open (return `result`).
  2. `if (!cfg().enabled) return result;`
  3. `const sig = stableSignature(ctx.call.name, ctx.call.arguments);`
  4. On `result.isError === true`: increment that bucket's
     `consecutiveFailures`. On success: **reset** `consecutiveFailures` to 0
     (D3 note / AC-5 — the *failure streak* resets on success; the *occurrence
     count* does not).
  5. **Consecutive-failure trip** (AC-4): when `consecutiveFailures >=
     threshold` the next `beforeToolCall` for that signature must halt with a
     **failure-framed** reason, e.g. `circuit-breaker: <tool> failed Nx` —
     distinct from the identical-args branch (AC-4 asserts `failed 3x`). Decide
     the seam: cleanest is for `beforeToolCall` (step 7 above) to also check the
     bucket's `consecutiveFailures` and, when it meets threshold, halt with the
     failure-framed reason instead of the repeat-framed one. Either way the
     failure trip is decided in `beforeToolCall` (the gate), using state the
     `afterToolCall` hook maintains. Keep the two reason strings distinct so
     AC-2 (`identical args`) and AC-4 (`failed`) can assert different text.
- `e.on("agent_start", () => { buckets.clear(); })` — reset per-run state
  (AC-7; `limits.ts:200-203` lifecycle). `/circuit-breaker reset` clears the
  live Map (AC-13).
- `e.registerCommand({ name: "circuit-breaker", … })` —
  `[on|off|ask|block|status|reset|threshold=<n>]` (Deliverable §2; shape mirrors
  `flow-guard.ts:191-231`): `on`/`off` set `enabled`; `ask`/`block` set `mode`;
  `threshold=<n>` sets `threshold` (reject non-positive, print a message — never
  throw); `reset` clears the live `buckets` Map; `status`/default prints
  `enabled`, `mode`, `threshold`, and the current bucket count (AC-13 §7.13 — no
  trip field; that is the complete status surface the design specifies). No
  subcommand throws.
- `activate` returns a teardown disposing **every** registration (both hooks,
  the `agent_start` listener, the command) in a `for … of` loop whose body is
  `try { d.dispose() } catch {}` — teardown must never throw
  (`limits.ts:297-305`). **Kill switch:** the very first line of `activate` is
  `if (process.env.EAGENT_CIRCUIT_BREAKER === "off") return () => {};` — a no-op
  disposer, nothing wired (AC-10; `recovery.ts:103`). **No capability** is
  declared and **no tool** is registered — the breaker has no side effect of its
  own (design §6 capability note).

#### Test harness pattern (`test/circuit-breaker.test.ts`)

Every live test goes through `makeHarness` (`test/helpers.ts:27`) with a scripted
`MockProvider`, registers an **inline stub tool** via `agent.tools.register`
(pattern from `limits.test.ts:78-79` using `defineTool` from
`src/kernel/define.js`), loads the extension via `host.use("circuit-breaker",
activateCircuitBreaker)`, optionally seeds store config via the
`/circuit-breaker` command, then drives `await agent.run("go")`. The
`MockProvider` responder scripts the assistant to emit the tool calls; assertions
inspect `agent.messages` (the transcript / `tool_result` blocks), the stub's
invocation count, and command output. The stub returns a fixed `{ content }`
result, or `{ content, isError: true }` for the failure scenarios.

Notes that keep the tests deterministic:
- A blocked call surfaces as a `tool_result` with `isError: true` whose content
  is `Tool call blocked: <reason>` (`agent.ts:324-325`) — assert on the
  `circuit-breaker:` substring inside it.
- A soft steer lands as a `user`-role message in `agent.messages` after it is
  drained before the next turn — assert the `circuit-breaker`/"identical" text is
  present (AC-1).
- For `ask`-mode tests, set `makeHarness({ ui: autoUI(true) })` to confirm and
  `autoUI(false)` to deny (`test/helpers.ts:16`; AC-6). The capability
  `fallback` defaults to `"allow"`, so any `confirm` you observe is the
  breaker's, not the capability layer's (the stub declares no capability).
- Restore any env var in `finally` (the kill-switch test) — pattern from
  `prune.test.ts` / `write-guard.test.ts`.

#### Task list — TDD order (every TEST names the invariant it protects and precedes its impl)

> Write the tests first. The pure-helper unit test (T-1) can pass against a
> minimal `stableSignature`; the live tests (T-2…T-11) drive the full hook
> ladder and so are written before, but go green after, the impl tasks I-1…I-6.
> A practical loop: write T-1, make it green with I-1's `stableSignature`; write
> T-2…T-11 (red); land I-2…I-6 until all green.

1. **T-1 — unit: signature is key-order invariant and value-sensitive.**
   *Invariant: two genuinely-identical calls must hash to one bucket, and
   advancing-argument calls must never collide.* Assert
   `stableSignature("read", {a:1,b:2}) === stableSignature("read", {b:2,a:1})`
   (key-order invariance, D2/AC-9) and
   `stableSignature("read", {offset:0}) !== stableSignature("read", {offset:1})`
   (value sensitivity, AC-8) and that a different tool name with the same args
   differs. (This also discharges the AC-12 hashing-helper coverage.)
   - Accept: `<TEST-CMD>` — this test passes.

2. **T-2 — live: a 2nd identical call triggers a soft steer, not a block.**
   *Invariant: the second occurrence nudges but never aborts a legitimate retry
   (D5/AC-1).* Script 2 identical tool calls (then a terminating text turn).
   Assert the 2nd call **still executes** (stub count == 2, no
   `Tool call blocked` result) **and** a steer message containing
   `circuit-breaker` and "identical"/"repeating" is present in the transcript
   (drained before the next turn). Implemented by I-1, I-2, I-3.
   - Accept: `<TEST-CMD>`.

3. **T-3 — live: the N-th (default 3rd) identical call is halted; oscillation
   and stable-stringify and ask-mode included.** *Invariant: a confirmed
   repetition pattern is stopped at the threshold, counted total-in-run, by
   canonical signature, with `ask`/`block` honored (AC-2/AC-3/AC-6/AC-9).*
   Sub-cases (one test or several, your call — each must assert its own
   invariant):
   - **block at N:** `mode=block` (via store or `/circuit-breaker block`),
     script 3 identical calls; assert the 3rd produces a `tool_result` whose
     content contains `circuit-breaker` and `called 3x with identical args`, and
     the stub executed only **twice** (AC-2).
   - **oscillation:** threshold 2, script A,B,A,B; assert A's 3rd *total*
     occurrence (4th call overall) is blocked even though A's repeats are not
     consecutive — proving total-in-run (D3/AC-3).
   - **stable-stringify:** threshold 3, script `{a:1,b:2}`, `{b:2,a:1}`,
     `{a:1,b:2}`; assert the 3rd trips — same signature despite key order
     (AC-9).
   - **ask allows/denies:** `mode=ask`; with `makeHarness({ ui: autoUI(true) })`
     the N-th call runs (stub executes); with `autoUI(false)` the N-th is
     blocked with the breaker reason (AC-6).
   Implemented by I-1…I-4.
   - Accept: `<TEST-CMD>`.

4. **T-4 — live: N consecutive failures halt with a failure-framed reason.**
   *Invariant: a model spinning on one broken call is stopped even if the
   occurrence math differs from the success path (AC-4).* Stub returns
   `{ isError: true }`; script 3 identical failing calls (threshold 3 on the
   failure branch). Assert the 3rd is halted and its blocked-result content
   matches the **failure** framing (e.g. `failed 3x`), distinct from the
   identical-args string. Implemented by I-2 (failure branch) + I-5.
   - Accept: `<TEST-CMD>`.

5. **T-5 — live: different-argument calls never trip.** *Invariant: productive
   distinct work (paginated reads with advancing offset) must pass untouched
   (D2/AC-8).* Script 3+ calls to the same stub with **different** args; assert
   none is blocked and no steer message appears. Implemented by I-1, I-2.
   - Accept: `<TEST-CMD>`.

6. **T-6 — live: a success resets the consecutive-failure count.** *Invariant:
   the failure streak counts *consecutive* failures, so an intervening success
   clears it (AC-5).* Script fail, fail, **succeed**, fail, fail (threshold 3 on
   the failure branch); assert no failure-trip block fires. Implemented by I-2's
   `afterToolCall` reset.
   - Accept: `<TEST-CMD>`.

7. **T-7 — live: state resets on `agent_start`.** *Invariant: the breaker's
   budget is per-run, with no cross-run carryover (AC-7).* Run once to
   one-below-threshold and finish; start a **second** `agent.run` issuing the
   same call; assert the second run's first call is **not** blocked (count
   started fresh). Implemented by I-2's `agent_start` reset.
   - Accept: `<TEST-CMD>`.

8. **T-9 — live: kill switch and `enabled=false` both suppress all
   interventions.** *Invariant: a single env var (and a store flag) fully
   disables tripping/steering, the env switch returning a clean no-op disposer
   (AC-10/AC-11).* With `EAGENT_CIRCUIT_BREAKER=off` (set/restored in `finally`),
   `mode=block`, issue the same call 5×; assert all 5 execute, no steer, no
   block, and the activation's disposer runs without throwing. Separately, with
   `enabled=false` via `/circuit-breaker off`, assert interventions are
   suppressed but the command still responds (extension stays loaded).
   Implemented by I-3, I-5.
   - Accept: `<TEST-CMD>`.

9. **T-10 — live: `host.unload` removes the hooks (no leak).** *Invariant:
   teardown is complete — after unload the breaker no longer intervenes
   (§8 rollback 3).* Load the extension, then `await host.unload("circuit-breaker")`
   (or dispose the activation handle), then run identical calls past threshold;
   assert nothing is blocked/steered (the hooks are gone) and unload did not
   throw. Implemented by I-5's teardown loop.
   - Accept: `<TEST-CMD>`.

10. **T-11 — live: `/circuit-breaker status` reports config, and the
    subcommands round-trip through the store.** *Invariant: the operator can
    observe and adjust the configured enabled/mode/threshold and current bucket
    count — the exact surface AC-13 §7.13 specifies.* Exercise the command:
    `status` prints `enabled`, `mode`, `threshold`, and bucket count; `off`/`on`
    toggle `enabled` in the store; `ask`/`block` set `mode`; `threshold=4` sets
    it to 4 and rejects a non-positive value; `reset` clears the live Map.
    Assert against persisted store values and printed output (use the
    `runCommand` helper idiom from `limits.test.ts:54-63`). The design's AC-13
    status surface is exactly enabled/mode/threshold/bucket-count plus these
    store-and-print round-trips — there is **no** trip-counter field, so do not
    assert one. Implemented by I-4.
    - Accept: `<TEST-CMD>`.

11. **I-1 — `stableSignature` helper** (exported, pure). Satisfies T-1; unblocks
    every live test's signature computation.
    - Accept: `<TEST-CMD>` (T-1 green); `<TC>` exit 0.

12. **I-2 — per-run state + the two hooks + reset.** The `buckets` Map, the
    `beforeToolCall` ladder (count → steer-at-2 → trip-at-threshold, with the
    failure-branch check), the `afterToolCall` outcome recorder (failure
    increment / success reset), and the `agent_start` reset. Satisfies
    T-2/T-4/T-5/T-6/T-7 and the core of T-3.
    - Accept: `<TEST-CMD>`; `<TC>` exit 0.

13. **I-3 — store-driven config + kill switch.** `cfg()` reading
    `enabled`/`threshold`/`mode` with defaults (`true`/`3`/`ask`), the
    `EAGENT_CIRCUIT_BREAKER=off` no-op-disposer early return. Satisfies the
    config-dependent parts of T-3/T-8/T-9.
    - Accept: `<TEST-CMD>`; `<TC>` exit 0.

14. **I-4 — `/circuit-breaker` command.** `on|off|ask|block|status|reset|threshold=<n>`.
    Satisfies T-11.
    - Accept: `<TEST-CMD>`; `<TC>` exit 0.

15. **I-5 — fail-open `try/catch` on each hook + teardown disposer loop.**
    Wraps both hook bodies (return decision/result unchanged on throw,
    `e.log.warn`), and the `for … of … try/dispose/catch` teardown. Satisfies
    T-10 and the AC-12 fail-open posture.
    - Accept: `<TEST-CMD>`; `<TC>` exit 0.

16. **I-6 — register in `host.ts`.** Import `circuitBreaker` from
    `./extensions/circuit-breaker.js` and add `["circuit-breaker",
    circuitBreaker]` to `BUILTIN_EXTENSIONS` **immediately after**
    `["content-guard", contentGuard]` (`host.ts:73`). (The design §2 says
    "after content-guard"; place it directly after that entry.) Additive only.
    - Accept: `<TC>` exit 0; `<FULL>` exit 0.

17. **D-1 — inventory reconciliation (closeout).** One bullet in `CLAUDE.md`
    "Where things live" describing `circuit-breaker`; one row in the README
    "Built-in extensions" table; bump the `src/extensions/  N built-in
    extensions` count from `30` to `31` (design §2, AC-14). (AC-14 may be
    asserted by a doc-check test if one exists; otherwise reconcile by hand at
    closeout — do **not** add a brittle exact-count test the design does not
    require beyond §7.14.)
    - Accept: `<FULL>` exit 0.

**Exit condition.**
- `<TEST-CMD>` → `# fail 0`, covering T-1…T-11 (AC-1…AC-14).
- `<TC>` exit 0.
- `<FULL>` exit 0 (`# fail 0`, 0 skipped) — **no regression**, especially
  `test/limits.test.ts` and `test/recovery.test.ts` stay green (§5).
- `circuit-breaker` is in `BUILTIN_EXTENSIONS` after `content-guard`; the
  `CLAUDE.md` inventory + README row + count `31` are reconciled.

---

## 3. Engineering Constraints Index

House rules (from `CLAUDE.md` "House conventions" + the design §5):

- **ESM + NodeNext.** `.js` import specifiers even when importing a `.ts` file
  (e.g. `import { defineTool } from "../kernel/define.js"`,
  `import type { ExtensionAPI } from "../kernel/extension.js"`,
  `import type { ToolDecision } from "../kernel/events.js"`,
  `import type { Message, ToolResult } from "../kernel/types.js"`).
- **Strict TypeScript.** `strict`, `noUncheckedIndexedAccess`,
  `noImplicitOverride`, `noFallthroughCasesInSwitch` all on. No `any` — model
  the `stableStringify` replacer value as `unknown` and narrow. Index access
  into the `buckets` Map returns `T | undefined`; handle the undefined branch.
- **Zero runtime dependencies except `jiti`.** Pure Node only. No SDK, no new npm
  package. The breaker uses only the public hook surface and `JSON.stringify`.
- **Capability-gated where it has side effects — and it has none.** Declare **no**
  capability and register **no** tool; the breaker only steers/blocks a decision
  the kernel already authorized (design §6).
- **Kill-switch env var.** `EAGENT_CIRCUIT_BREAKER=off` → no-op disposer
  (`recovery.ts:103` pattern).
- **Dispose loop that never throws.** Teardown iterates disposers in
  `try/catch` (`limits.ts:297-305`).
- **Fail open.** Every hook body wrapped in `try/catch` that `e.log.warn`s and
  returns the decision/result unchanged (`limits.ts:230-233`).
- **Offline `node:test` via `tsx`.** No network, no `ANTHROPIC_API_KEY`; drive
  the scriptable `MockProvider` through `makeHarness`.

**Hook surface used** (design §5): events via `e.on` (`agent_start`); filters via
`e.hook` (`beforeToolCall` → `ToolDecision` with `{ call }` context;
`afterToolCall` → `ToolResult` with `{ call }` context); `e.agent.handle.steer`,
`e.agent.ui.confirm`, `e.store.get/set`, `e.registerCommand`, `e.log.warn`.

**Commit conventions** (no AI/model/tooling mentions in messages):
- Opener: `feat(phase1): circuit-breaker — repetition / consecutive-failure fail-fast`.
- Within-round fixes: `fix(phase1-roundR): <keyword>`.
- Trailers on every commit: `npm test` and `npm run typecheck` results, e.g.

  ```
  npm test: 4XX/4XX pass, 0 skipped
  npm run typecheck: exit 0
  ```

---

## 4. Data / Fixture Dependencies

- **Reuse `test/helpers.ts`** — `makeHarness` (provider + host + commands +
  agent), `autoUI(true|false)` for the `ask`-mode confirm/deny cases
  (`helpers.ts:16`), `silentLogger`. No new helper change is required (unlike the
  `risk-guard` task, which added an optional `logger`; this task needs none —
  the steer/block assertions read the transcript, not the log).
- **Inline stub tool** via `defineTool` (`src/kernel/define.js`) + `agent.tools.register`,
  registered per test (pattern: `limits.test.ts:78-79`). It returns a fixed
  `{ content: "ok" }` for success scenarios and `{ content: "boom", isError: true }`
  for the consecutive-failure scenarios. It declares **no capability** (so the
  capability layer never prompts; the harness `fallback` is `"allow"`).
- **Scripted `MockProvider`** — a `responder` array or `(req, i) => MockTurn`
  function emitting the identical / oscillating / failing / advancing-arg tool
  calls, then a terminating `{ text: "done" }` turn (`mock.ts:33-36`,
  `MockTurn.toolCalls`). Give each scripted `toolCall` an explicit `id` when a
  test needs to find a specific `tool_result` by `toolCallId`.
- **No committed fixtures, no temp files, no `EAGENT_WORKSPACE`** — the breaker
  touches no filesystem. The only env var is the kill switch
  `EAGENT_CIRCUIT_BREAKER`, saved/restored in `finally` (`write-guard.test.ts`
  env pattern).
- **Command-output capture** — the `runCommand(cmd, agent, args)` idiom
  (`limits.test.ts:54-63`) collecting `print` lines for the `/circuit-breaker`
  assertions (T-11).

---

## 5. Regression Protection

This is Phase 1; the regression surface is the **full existing suite**.

- **`<FULL>` (`npm test`) must stay `# fail 0`, 0 skipped** after every impl
  task — re-run it after I-6 (the host registration) and again at Phase exit.
- **`test/limits.test.ts` and `test/recovery.test.ts` must stay green
  specifically.** The breaker shares the `beforeToolCall` / `afterToolCall` /
  `agent_start` seams with `limits` and the `afterToolCall` seam with `recovery`.
  Both are independent of the breaker (the hook bus runs filters in registration
  order, and an earlier `block` short-circuits the rest via `agent.ts:322`). The
  breaker returns the input decision/result **unchanged** on every path except an
  enabled identical/failure trip at threshold, and **never un-blocks** an existing
  `block` (design §5/§6) — so it cannot perturb `limits`'s budget gate or
  `recovery`'s hint append. Confirm by running both targeted files plus `<FULL>`.
- **Adding a builtin to `host.ts` is additive.** No existing test asserts a
  builtin count (verified for prior `risk-guard`/`microagents` tasks). If a doc
  reconciliation check exists, the count bump to `31` (D-1) keeps it green; if
  not, do not introduce a brittle exact-count assertion beyond what design §7.14
  asks.
- **No `test/helpers.ts` change**, so no helper-shape regression risk this task.
