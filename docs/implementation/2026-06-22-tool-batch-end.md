# Implementation Guide — `tool_batch_end`: a wave-settled lifecycle event

Status: closed
Closing-commit: 36c6090
Closed-on: 2026-06-23
Deferred: none
Date: 2026-06-22
Companion design: `docs/design/2026-06-22-tool-batch-end.md` (PASSED)
Audience: a fresh agent doing TDD, start-to-finish, no prior context.

This guide turns the passed design into an ordered, test-first task list. It
introduces **no requirement absent from the design**. Every claim about
behavior, payload shape, emit placement, and scope traces to a design section
(cited inline as `[D…]`, `[§n]`, or `[AC#n]`). When this guide and the design
disagree, the design wins — stop and reconcile.

The whole change is **additive and observe-only**: one new key on the
`KernelEvents` map plus one `emit` call in the agent loop. No new file, no host
wiring, no command, no capability, no kill switch — all deliberate non-goals
(`[§3]`, Deliverables N/A items `[§2]`).

---

## 1. Task Index — design Deliverables + Acceptance Criteria → phase tasks

The work is a single phase (the change is two source lines plus a test; nothing
is genuinely separable — see Phase Breakdown rationale). The table maps every
design Deliverable (`[§2]`) and Acceptance Criterion (`[§7]`) to the task that
discharges it.

| Design item | Source | Discharged by |
| ----------- | ------ | ------------- |
| **Deliverable: Event type addition** — `tool_batch_end: { batch: {call,result}[] }` on `KernelEvents` | `[§2]`, `[D2]` | P1-T3 (impl) |
| **Deliverable: Single emit** — one `emit("tool_batch_end", { batch })` after `dispatch`, before message append + `turn_end` | `[§2]`, `[D4]` | P1-T5 (impl) |
| **Deliverable: Test** — 3-tool wave → exactly one event; ordered pairs; `tool_end` 3×; `turn_end` unchanged; single-tool wave → length-1 | `[§2]`, `[AC#2–#6]` | P1-T2, P1-T4 (tests) |
| **Deliverable: host.ts registration — N/A by design** | `[§2]`, `[§3]` | P1-T6 (confirm absence) |
| **Deliverable: Command — N/A by design** | `[§2]`, `[§3]` | P1-T6 (confirm absence) |
| **Deliverable: Kill switch — N/A by design** | `[§2]`, `[§3]` | P1-T6 (confirm absence) |
| **Deliverable: Docs/inventory reconciled at closeout** — row in `docs/EXTENSIONS.md`, entry in `README.md`; `CLAUDE.md` unchanged | `[§2]`, `[AC#9]` | P1-T7 (docs) |
| **AC#1: Type exists, compiles** — consumer `on("tool_batch_end", ({ batch }) => …)` type-checks, `batch` inferred, no cast | `[§7.1]` | P1-T2, P1-T3 |
| **AC#2: Exactly one per 3-tool wave** | `[§7.2]` | P1-T2 |
| **AC#3: Ordered pairs** — `batch.length === 3`, `batch.map(p => p.call.id)` equals requested order | `[§7.3]` | P1-T2 |
| **AC#4: `tool_end` unchanged** — fires 3× in same run | `[§7.4]` | P1-T2 |
| **AC#5: `turn_end` unchanged** — whole-run `turn_end` counter stays `2` for the tool-then-text run (one tool turn + one text turn; the additive emit perturbs neither) | `[§7.5]` | P1-T2 |
| **AC#6: Single-tool wave still emits** — one event, `batch.length === 1` | `[§7.6]` | P1-T4 |
| **AC#7: Throwing consumer does not break the loop** | `[§7.7]`, `[§5]` | P1-T2 or P1-T4 (sub-assertion) |
| **AC#8: Surface ceiling green** — kernel `< 2200` lines, `EXPECTED_EXPORTS` untouched | `[§7.8]`, `[D6]`, `[§3]` | P1-T8 (regression) |
| **AC#9: Docs reconciled** — `grep -c tool_batch_end` ≥ 1 in EXTENSIONS.md and README.md | `[§7.9]` | P1-T7 |

---

## 2. Phase Breakdown

### Phase 1 — add the `tool_batch_end` event (the whole change)

**Why one phase.** The design is explicitly "the smallest possible change"
(`[§3]`, `[D6]`): ~1 line in `events.ts` and ~2 lines in `agent.ts`, plus one
test block and a two-line docs reconciliation. The type and the emit are
mutually dependent (the emit references the new event key; the key is dead
without the emit), and a single test exercises both. Splitting them into
separate phases would create a non-compiling intermediate (`emit` of an
undeclared event key fails `noImplicitAny`/key-typing under strict TS) for no
benefit. So: one phase, TDD within it.

**Entry condition.**
- Working tree clean on a fresh feature branch off `init` (the repo's main).
  Do not work on `init` directly (house rule: branch first).
- Baseline green: `npm test` exit 0 and `npm run typecheck` exit 0 **before any
  edit**. Record the kernel line count for the ceiling sanity check:
  `node --import tsx -e 'import{readdirSync,readFileSync}from"node:fs";import{join}from"node:path";let n=0;const d=join(process.cwd(),"src","kernel");for(const f of readdirSync(d))if(f.endsWith(".ts"))n+=readFileSync(join(d,f),"utf8").split("\n").length;console.log(n)'`
  — expect **1780** (measured; ceiling 2200, headroom 420). (The design's
  `[D6]` cites 1768; the live kernel is 1780. Either is comfortably under the
  real gate — `test/kernel-surface.test.ts` asserts `lines < 2200` — so a small
  drift is expected, not a defect. Use the number you actually measure as the
  baseline for the "+~3 lines" check below.)

**Design refs for this phase.**
- Event type + payload shape: `[§2]` Deliverable 1, `[D2]`.
- Emit placement and timing: `[§2]` Deliverable 2, `[D4]`.
- Emit-for-every-group (incl. wave of one): `[D3]`.
- Strictly additive / zero behavior change: `[D5]`, `[§3]`.
- Error isolation of the new handler: `[§5]`, `[§8]`.
- Surface ceiling: `[D6]`, `[§3]` (no runtime export added).
- Concrete code anchors:
  - `KernelEvents` map: `src/kernel/events.ts:11-38` (after `tool_end` at
    `:32`). `ToolCallBlock` and `ToolResult` are already imported at
    `src/kernel/events.ts:9` — **no new import** (`[§5]`).
  - Emit site: `src/kernel/agent.ts:205` is `const results = await this.dispatch(calls)`;
    the message append is `:206-218`; `turn_end` is `:219`. The new emit lands
    immediately after `:205` and before `:206`.
  - `dispatch` returns ordered `DispatchOutcome[]` (`{ call, result }`),
    defined `src/kernel/agent.ts:367-370`, built in `dispatch` at `:288-299`.
  - `HookBus.emit` isolates handler errors (`src/kernel/hooks.ts:50-61`,
    try/catch → `reportHandlerError`); a throwing handler cannot break the loop.

**Task list (strict TDD order — every TEST precedes the impl it protects).**

---

#### P1-T1 — Establish the red baseline (no production edit)

Confirm the suite is green before touching anything, so the first test failure
is unambiguously *our* missing feature and not pre-existing breakage.

- Run `npm test` and `npm run typecheck`; both must be exit 0.
- Do **not** edit any source yet.

**Acceptance (from repo root):**
```bash
npm test
npm run typecheck
```
Both exit 0.

---

#### P1-T2 — TEST: a parallel wave settles into exactly one ordered batch

> **Business invariant protected:** *A single parallel dispatch group produces
> exactly one wave-settled signal carrying the whole wave, in requested order —
> and it neither replaces nor suppresses the per-tool `tool_end` and turn-level
> `turn_end` signals.* This is the core contract of the new seam (`[§1]`,
> `[D3]`, `[D5]`, `[AC#2–#5]`). Without it, a once-per-wave consumer (incremental
> typecheck, secrets sweep, cost rollup — `[§1]`) has nothing reliable to attach
> to.

Write this test FIRST. It must **fail** because `tool_batch_end` does not yet
exist (and must fail at the type level too — see the typecheck step). Extend
`test/agent.test.ts` (alongside the existing parallel/tool-use cases at
`test/agent.test.ts:8-58`), reusing `makeHarness` from `./helpers.js`
(`[§5]`, `[§4]`). Script a MockProvider responder with a 3-tool assistant turn,
each tool call given an explicit `id` so order is assertable (mirrors
`test/agent.test.ts:36`, `:55-57`).

The single test should assert, **in one run**:
1. **AC#2** — a counter incremented in `agent.hooks.on("tool_batch_end", …)`
   equals `1`.
2. **AC#3** — that event's `batch.length === 3` and
   `batch.map((p) => p.call.id)` deep-equals the requested id order (e.g.
   `["c1","c2","c3"]`).
3. **AC#4** — a `tool_end` counter equals `3` in the same run.
4. **AC#5** — a whole-run `agent.hooks.on("turn_end", …)` counter equals `2`
   for this tool-then-text run: the loop emits `turn_end` once for the
   tool-bearing turn (`src/kernel/agent.ts:219`) and once for the following
   text turn (`calls.length === 0`, `src/kernel/agent.ts:201`). The point of
   AC#5 is that the new emit is *additive* — it must not add or suppress a
   `turn_end`, so the unchanged count is exactly `2` (NOT `1`: a whole-run
   counter sees both turns). If you instead want to assert "the tool-bearing
   turn ends once", gate the counter on `({ turn }) => turn === 1`.
5. **AC#1** — inside the handler, destructure `({ batch }) =>` with **no cast**;
   `batch` must be inferred as the `{ call, result }` pair array. (This is
   enforced by `npm run typecheck` in the acceptance step, not a runtime assert.)

Notes that keep the test honest and offline:
- Use three plain tools that return synchronously (or one slow + two fast, as in
  `test/agent.test.ts:43-52`, if you also want to re-prove order-under-timing —
  optional; `[AC#3]` only requires requested order).
- Tools register via `defineTool` from `../src/kernel/define.js` and
  `agent.tools.register(...)` (pattern at `test/agent.test.ts:15-22`).
- Capture the batch payload in a closure array (e.g.
  `const batches: { batch: { call: ToolCallBlock; result: ToolResult }[] }[] = []`)
  so post-run assertions can read `batches[0].batch`.
- Keep it offline: no network, no API key (`[§5]`); `makeHarness` defaults to the
  MockProvider.

**Acceptance (from repo root) — expect RED:**
```bash
node --import tsx --test test/agent.test.ts   # new test FAILS (event absent)
npm run typecheck                              # FAILS: "tool_batch_end" not assignable / unknown key
```
The typecheck failure on the unknown event key is expected and desirable — it
proves the test is binding against a type that does not yet exist.

---

#### P1-T3 — IMPL: add the `tool_batch_end` key to `KernelEvents`

Minimal, additive (`[§2]` Deliverable 1, `[D2]`). In `src/kernel/events.ts`,
add **one** key to the `KernelEvents` map, immediately after the `tool_end`
entry (`src/kernel/events.ts:32`):

```ts
/** A parallel tool wave settled; carries the ordered {call,result} pairs. */
tool_batch_end: { batch: { call: ToolCallBlock; result: ToolResult }[] };
```

- `ToolCallBlock` and `ToolResult` are already imported (`src/kernel/events.ts:9`)
  — add **no** import (`[§5]`).
- Field shape mirrors `tool_end`'s `{ call, result }` exactly (`[D2]`), so a
  consumer's element destructure is identical to a `tool_end` handler.
- Do **not** add anything to `src/kernel/index.ts` — `KernelEvents` is a type
  re-exported via `export * from "./events.js"` and never appears in
  `Object.keys(kernel)`, so `EXPECTED_EXPORTS` stays untouched (`[§3]`, `[D6]`).

After this task `npm run typecheck` passes (the test now references a declared
key), but the runtime test still fails — nothing emits yet.

**Acceptance (from repo root):**
```bash
npm run typecheck                              # exit 0 (key now declared)
node --import tsx --test test/agent.test.ts    # still RED: no emit yet
```

---

#### P1-T4 — TEST: a single-tool wave still emits one length-1 batch + the loop survives a throwing consumer

> **Business invariant protected (a):** *Every dispatch group fires the event,
> including a wave of one — the firing condition is "once per dispatch group,
> always", with no length gate and no kernel policy that "a wave of one doesn't
> count"* (`[D3]`, `[AC#6]`). **Invariant (b):** *The event is observe-only — a
> consumer that throws inside its handler cannot break the agent loop*
> (`[§5]`, `[§8]`, `[AC#7]`).

Add a second test (or extend with a clearly separate case) in
`test/agent.test.ts`. Two assertions, ideally one run each for clarity:

- **AC#6 (single-tool wave):** script a one-tool turn then a text turn (the
  `test/agent.test.ts:8-14` pattern). Assert exactly one `tool_batch_end` whose
  `batch.length === 1`.
- **AC#7 (throwing consumer):** in a run with a tool wave, register
  `agent.hooks.on("tool_batch_end", () => { throw new Error("boom"); })` and
  assert the run still completes with the expected `reason` and final text.
  Silence the reporter around this case so the thrown error does not pollute
  test output, exactly as `test/hooks.test.ts:23-36` does:
  `import { setHandlerErrorReporter } from "../src/kernel/hooks.js";` then
  `setHandlerErrorReporter(() => {})` before the run and restore it after
  (`setHandlerErrorReporter((event, err) => console.error(event, err))`).
  Restoring matters: leaking the silent reporter would mask errors in later
  tests in the same file/process.

This still relies only on the type declared in P1-T3; it must **fail at runtime**
(no emit) until P1-T5.

**Acceptance (from repo root) — expect RED on the new assertions:**
```bash
node --import tsx --test test/agent.test.ts    # single-tool / throwing-consumer cases FAIL (no emit)
npm run typecheck                              # exit 0
```

---

#### P1-T5 — IMPL: emit `tool_batch_end` once, after `dispatch`, before the message append

The whole behavioral change (`[§2]` Deliverable 2, `[D4]`). In
`src/kernel/agent.ts`, immediately after `const results = await this.dispatch(calls);`
(`src/kernel/agent.ts:205`) and **before** the `toolMessage` is built/appended
(`:206-218`) and **before** `turn_end` (`:219`), insert exactly one emit:

```ts
const results = await this.dispatch(calls);
await this.hooks.emit("tool_batch_end", {
  batch: results.map((r) => ({ call: r.call, result: r.result })),
});
```

- `results` is `DispatchOutcome[]`, already ordered (`src/kernel/agent.ts:288-299`,
  `:367-370`). The map is a near-identity to the same `{ call, result }` field
  names `dispatch` already returns (`[D2]`), with a typed callback — no index
  access, so it compiles clean under `noUncheckedIndexedAccess` (`[§5]`).
- **Unconditional:** no `if (calls.length > 1)` gate — emit for every group,
  including a wave of one (`[D3]`). (`dispatch` is only reached when
  `calls.length > 0`; pure-text turns return before it at
  `src/kernel/agent.ts:194-203`, so the event correctly never fires on a
  tool-less turn — `[§5]`.)
- **Touch no other line.** Do not reorder, fold, or alter `tool_end`
  (`src/kernel/agent.ts:310`), `turn_end` (`:219`), the message append, the
  terminate check (`:221-224`), or `runOne`. Strictly additive (`[D5]`, `[§3]`).
  In particular, do **not** move the emit into `runOne` — that runs per-tool and
  cannot see the whole group (`[D4]` rejects option (c)).

After this task the P1-T2 and P1-T4 cases go green.

**Acceptance (from repo root):**
```bash
node --import tsx --test test/agent.test.ts    # GREEN (all batch cases pass)
npm run typecheck                              # exit 0
```

---

#### P1-T6 — Confirm the deliberate absences (no-op verification, no edit)

The design marks host registration, a command, and a kill switch as **N/A by
design** (`[§2]`, `[§3]`); these boxes are checked by *confirming the absence is
intentional*. This task is a guard against accidental scope creep, not an edit.

- Confirm **no** new file under `src/extensions/` was created.
- Confirm **no** entry was added to `src/host.ts` (this is a kernel event, not an
  extension — `[§2]` Deliverable 4, `[§3]`).
- Confirm **no** command registered, **no** capability declared, **no** env kill
  switch added (`[§3]`).

**Acceptance (from repo root) — all must report the absences:**
```bash
git status --porcelain                          # only events.ts, agent.ts, test/agent.test.ts, docs (P1-T7) appear
git diff --stat                                 # no src/extensions/* or src/host.ts in the list
grep -rn tool_batch_end src/host.ts src/extensions 2>/dev/null; echo "exit=$?"   # no matches (grep exit 1)
```

---

#### P1-T7 — DOCS: reconcile the documented event set (closeout)

Per `[§2]` Deliverable 6 and `[AC#9]`. Make the documented event set match the
`KernelEvents` keys.

- **`docs/EXTENSIONS.md`** — add a row to the lifecycle-events table, after the
  `tool_end` row at `docs/EXTENSIONS.md:248`:
  ```
  | `tool_batch_end` | `{ batch }` | A parallel tool wave settled (the ordered `{call,result}` pairs). |
  ```
- **`README.md`** — add `tool_batch_end` to the events listing in the mermaid
  diagram / prose around `README.md:154-159` (the `Events — e.on()` subgraph).
  Place it with the tool-related events, e.g. extend the
  `"tool_start · tool_end · usage"` node to mention `tool_batch_end`.
- **`CLAUDE.md`** — **no change** (`[§2]`, `[AC#9]`): it carries no
  lifecycle-events enumeration to reconcile (the Hook-bus row in the
  Architecture table and the per-extension filter-hook mentions do not list
  lifecycle events). Do not invent one.
- Reconcile that the documented set (EXTENSIONS.md, README.md), the
  `KernelEvents` keys in `src/kernel/events.ts`, and the design all list the
  same events (`[§2]` closeout, `[AC#9]`).

**Acceptance (from repo root):**
```bash
grep -c tool_batch_end docs/EXTENSIONS.md       # >= 1
grep -c tool_batch_end README.md                # >= 1
grep -c tool_batch_end CLAUDE.md; echo "expect 0"   # 0 (CLAUDE.md untouched)
```

---

#### P1-T8 — REGRESSION: full suite, typecheck, and the surface ceiling

Run the whole offline suite to prove zero behavior change and that the
minimalism guard stays green (`[§7.8]`, `[D6]`, `[§3]`).

- `npm test` exit 0 — in particular `test/kernel-surface.test.ts` must pass:
  the kernel line count stays `< 2200` (was ~1780; this change adds ~3 lines), and
  the `EXPECTED_EXPORTS` list (`test/kernel-surface.test.ts:21-47`) is **unchanged**
  (no new runtime export — `[§3]`, `[D6]`).
- `test/agent.test.ts` and `test/scenario.test.ts` must remain green — the
  pre-existing assertions there describe behavior this change must not alter
  (parallel ordering, tool-use turn, terminate/stop, capabilities, errors).
- `npm run typecheck` exit 0.

**Acceptance (from repo root):**
```bash
node --import tsx --test test/agent.test.ts test/hooks.test.ts   # GREEN
npm run typecheck                                                # exit 0
npm test                                                         # exit 0 (incl. kernel-surface ceiling)
```

**Exit condition (Phase 1 / whole task).**
- All of P1-T2 / P1-T4 assertions pass (`[AC#1–#7]`).
- `npm test` and `npm run typecheck` exit 0; `test/kernel-surface.test.ts` green
  with kernel `< 2200` lines and `EXPECTED_EXPORTS` untouched (`[AC#8]`).
- `grep -c tool_batch_end` ≥ 1 in `docs/EXTENSIONS.md` and `README.md`;
  `CLAUDE.md` unchanged (`[AC#9]`).
- Deliberate absences confirmed: no `src/extensions/` file, no `src/host.ts`
  entry, no command/capability/kill-switch (`[§3]`, P1-T6).
- Diff is `events.ts` (+~1), `agent.ts` (+~2/3), `test/agent.test.ts`, and the
  two docs files — nothing else.

---

## 3. Engineering Constraints Index (house rules + commit conventions)

These bind every task above. Source: `CLAUDE.md` "House conventions" and the
project task brief.

- **ESM + NodeNext, `.js` specifiers even for `.ts` sources.** Test imports use
  `../src/kernel/define.js`, `../src/kernel/hooks.js`, `./helpers.js`, etc. — the
  `.js` extension is mandatory under `module: NodeNext` + `verbatimModuleSyntax`.
- **Strict TypeScript.** `strict`, `noUncheckedIndexedAccess`,
  `noImplicitOverride`, `noFallthroughCasesInSwitch` are on. **No `any`.** The
  payload uses a typed `.map` callback — no array indexing, no cast (`[§5]`).
- **Zero runtime deps except `jiti`; pure Node only.** Do not add packages. This
  change adds none.
- **Tests are `node:test` via `tsx`, fully offline** against the scriptable
  `MockProvider`. No network, no `ANTHROPIC_API_KEY`. Drive via
  `makeHarness` (`test/helpers.ts`).
- **Additive, observe-only, zero behavior change.** This is a *kernel event*,
  not an extension — so the usual "every extension is capability-gated + ships a
  kill switch" rule applies to extensions; here, by design, there is no
  capability, no command, and no kill switch (an event with zero consumers is
  inert — `[§3]`, `[§8]`). Do not add them.
- **Minimalism guard.** `test/kernel-surface.test.ts` pins the public export
  surface and a 2200-line kernel ceiling. Do not touch `EXPECTED_EXPORTS`; keep
  the addition to ~3 lines (`[D6]`).
- **Commit conventions.**
  - Branch first (do not commit on `init`). Commit/push only when the user asks.
  - Prefix: `feat(phase1)` for the feature commit; `fix(phase1-roundR)` for any
    review-round follow-up.
  - Trailers: include `npm test` and `npm run typecheck` results.
  - **No mention of AI/model/tooling** in commit messages.
  - End the commit message with the session trailer required by the repo:
    `Claude-Session: https://claude.ai/code/session_014R8mvT426fK6BkWHbdbLt2`.
  - Suggested message:
    ```
    feat(phase1): add tool_batch_end wave-settled lifecycle event

    Emit one observe-only tool_batch_end after each dispatch group, carrying
    the ordered {call,result} pairs. Additive; no behavior change to existing
    events. Reconcile EXTENSIONS.md / README.md event lists.

    npm test: pass
    npm run typecheck: pass

    Claude-Session: https://claude.ai/code/session_014R8mvT426fK6BkWHbdbLt2
    ```

---

## 4. Data / Fixture Dependencies

- **`test/helpers.ts` — `makeHarness` / `lastText` (reuse, do not duplicate).**
  `makeHarness({ responder })` wires an `Agent` + `MockProvider` offline with an
  auto-allow capability fallback (`test/helpers.ts:27-45`). Use it exactly as
  the existing cases do (`test/agent.test.ts:9`, `:34`). `lastText(agent)`
  returns the last assistant text for the final-answer assertion in P1-T2/P1-T4.
- **`MockProvider` responder script (no new fixture file).** Script turns inline
  via the `responder` array/function: a tool turn is
  `{ toolCalls: [{ name, id, arguments? }, …] }`; a text turn is `{ text }`
  (shapes in `src/providers/mock.ts:20-31`, `:85-92`). Give each tool call an
  explicit `id` so `[AC#3]` order is assertable (the provider honors `call.id`
  at `src/providers/mock.ts:86`). No JSON/YAML fixtures, no temp files, no
  filesystem.
- **`defineTool` for the wave's tools.** Register simple synchronous tools
  (`{ content: "…" }`) via `defineTool` (`../src/kernel/define.js`) +
  `agent.tools.register(...)`, as at `test/agent.test.ts:15-22`. Optionally one
  `async` slow tool to also re-prove order-under-timing (`test/agent.test.ts:43-52`).
- **`setHandlerErrorReporter`** from `../src/kernel/hooks.js` for the AC#7
  throwing-consumer case — silence then restore, exactly per
  `test/hooks.test.ts:23-36`.

No new helpers, fixtures, or directories are required or permitted by the design.

---

## 5. Regression Protection — tests that must stay green

Run `npm test` (exit 0) at P1-T8; these specifically must not regress:

- **`test/agent.test.ts`** (existing cases, unchanged behavior): the tool-use
  turn (`:8-31`), **parallel order preservation** (`:33-58`) — the ordering this
  event depends on — veto/rewrite via `beforeToolCall` (`:60-105`), `terminate`
  and `stop()` (`:107-145`), `transformContext` (`:147-165`), steering
  (`:167-181`), capability enforcement (`:183-204`), provider/stream errors
  (`:206-241`), unknown tool (`:243-251`), thinking/reasoning (`:253-266`). The
  new event must not perturb any of these (`[D5]`, `[§3]`).
- **`test/hooks.test.ts`**: registration-order emit, **throwing-handler
  isolation** (`:23-36`) — the guarantee AC#7 reuses — filter threading,
  short-circuit, dispose. `HookBus` is untouched (`[§5]`).
- **`test/kernel-surface.test.ts`** (the minimalism guard): `EXPECTED_EXPORTS`
  must stay byte-identical (no new runtime export) and the kernel must stay
  `< 2200` lines (`[AC#8]`, `[D6]`, `[§3]`).
- **`test/scenario.test.ts`**: end-to-end scenarios must pass unchanged
  (named explicitly in the brief as a must-stay-green regression).
- **The rest of the offline suite** (`test/*.test.ts`, one file per
  primitive/extension): all green, since the change is additive and observe-only
  and adds no consumer.

If any of these go red after the impl, the change is not additive — revert the
emit and re-derive (rollback is the two-line revert in `[§8]`).
