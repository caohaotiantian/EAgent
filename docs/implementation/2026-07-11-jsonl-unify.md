# Implementation — Unify the CLI `--json` and HTTP `/run` JSONL schemas (Cycle 7)

Slug: `2026-07-11-jsonl-unify` (matches the design)
Status: **L2 closed** — rounds 3 and 4 both passed (zero severe, zero general) by two independent fresh
reviewers; two-generation termination satisfied. Every source anchor, the 5-vs-2 terminal-assertion split,
the additive `subs`→`wireJsonl` swap, and the baselines (suite 1364/1, kernel 2248/2250) were verified
against the code. Ready for L3.

## 1. Task Index

Design: `docs/design/2026-07-11-jsonl-unify.md`. Deliverables D1–D5 → §2 phases; Acceptance AC1–AC5 →
per-phase exit conditions; KDD1–KDD4 → the design. `<TEST-CMD>` = `npm test`. Three phases, each an
independently-committable unit:

- **Phase 1** — the shared serializer `src/jsonl.ts` (`eventToJsonl` mapper + `wireJsonl`) + its unit
  tests `test/jsonl.test.ts` (D1; AC1 + AC2 layer-2). Foundation: the risky shape logic is RED-first
  tested in isolation before either front end depends on it.
- **Phase 2** — both front ends adopt the mapper (D2 CLI byte-identical + D3 server canonicalized), with
  their test updates (AC2 layer-3, AC3, AC4, AC5 server-test carve-out).
- **Phase 3** — docs: the canonical JSONL contract section + CHANGELOG + the `cli-json.md` note update
  (D4).

## 2. Phase Breakdown

### Phase 1 — shared serializer `src/jsonl.ts` + unit tests

- **Entry condition:** branch `chore/production-hardening`, suite green (baseline 1364 pass / 1 skip);
  kernel 2248/2250; `src/jsonl.ts` does not yet exist.
- **Design references:** D1 (the mapper's 9 canonical shapes + the byte-identity invariants: exact key
  insertion order, `?? false` on `tool_end.isError`, `?? null` on `action_required.options`, and
  **omitting** `usage.model` (`events.ts:50`) and `tool_end.step` (`events.ts:43`)); KDD3; AC1; AC2
  layer-2. Verbatim source anchors: `cli.ts:333-347` (the canonical CLI shapes to reproduce),
  `types.ts:23` (`ToolCallBlock.id`).
- **Task list (TDD order — tests first):**
  1. **T1.1 (tests, RED)** — `test/jsonl.test.ts`:
     - **AC1 (mapper units):** for each event, assert `eventToJsonl(type, payload)` returns the exact
       canonical object (fields + values): `text_delta` → `{type:"text_delta", text}`; `reasoning_delta`
       → `{type:"reasoning_delta", text}`; `message` → `{type:"message", role, content}`; `tool_start`
       → `{type:"tool_start", id, name, arguments}`; `tool_end` → `{type:"tool_end", id, name, isError,
       content}` **with `isError` defaulting via `?? false`** (assert a payload whose `result.isError` is
       `undefined` yields `isError:false`); `usage` → `{type:"usage", usage, cumulative}` **and assert no
       `model` key leaks**; `agent_end` → `{type:"agent_end", reason, usage}` for the CLI case and
       `{type:"agent_end", reason, usage, session}` when `session` is passed; `error` →
       `{type:"error", where, message}`; `action_required` → `{type:"action_required", id, question,
       options}` **with `options` defaulting via `?? null`**. Assert **key insertion order** by comparing
       `JSON.stringify(eventToJsonl(...))` to the exact expected string (order-sensitive).
     - **AC2 layer-2 (in-process wiring golden):** build a **scripted mock agent** — an object with a
       `hooks` whose `.on(event, fn)` records the handler and returns a `{dispose}` — pass it to
       `wireJsonl(emit, agent)` with an `emit` that pushes `JSON.stringify(obj)+"\n"` into an array; fire
       each of the **six common streaming events** (`text_delta`, `reasoning_delta`, `message`,
       `tool_start`, `tool_end`, `usage`) through the recorded handlers; assert the collected lines are
       **exactly** the strings the pre-refactor CLI produced for those events (hard-coded expected
       strings, byte-for-byte). Also assert `wireJsonl` returns a disposable array and calling
       `.dispose()` on each unsubscribes (the recorded handler count drops).
  2. **T1.2 (impl)** — `src/jsonl.ts` (new, zero-dep, ESM `.js` specifiers):
     - `export function eventToJsonl(type, payload)` — a pure mapper producing the 9 canonical shapes
       above. Construct each object with keys in the **exact insertion order** the CLI currently uses
       (so `JSON.stringify` is byte-identical). Omit `usage.model` and `tool_end.step`. Coalesce
       `isError ?? false` and `options ?? null`. Type it precisely (no `any`); import the payload/event
       types from `./kernel/index.js` (or the specific kernel modules) as needed.
     - `export function wireJsonl(emit, agent)` — registers the **six common streaming handlers** on
       `agent.hooks` (each calling `emit(eventToJsonl(type, …))`), and returns the array of
       `{dispose(): void}` subscriptions (the shape `agent.hooks.on` already returns). It does **not**
       wire `agent_end`, `error`, or `action_required` — those stay per-front-end (KDD3), shaped via
       `eventToJsonl`.
- **Per-task acceptance commands:**
  - `node --import tsx --test test/jsonl.test.ts`
- **Exit condition:** `test/jsonl.test.ts` green; `npm run typecheck` 0; `npm run typecheck:test` 0;
  `npm run build` 0; `test/kernel-surface.test.ts` green (kernel line count **unchanged** — `src/jsonl.ts`
  is top-level, not `src/kernel/`); full `npm test` 0 fail (no front-end change yet, so all existing tests
  still pass).

### Phase 2 — both front ends adopt the shared mapper (CLI byte-identical + server canonicalized)

- **Entry condition:** Phase 1 merged; `src/jsonl.ts` exports `eventToJsonl` + `wireJsonl`, its tests
  green.
- **Design references:** D2 (CLI byte-identical), D3 (server canonicalized: `id` on tool events,
  `reasoning_delta` subscribed, terminal dual-emit **`done` first / `agent_end` last** with `session`,
  `error` via mapper), KDD1/KDD2/KDD4; AC2 layer-3, AC3, AC4, AC5 server-test carve-out. Source anchors:
  `cli.ts:333-347`, `server.ts:310-416` (the `subs` block `:380-388`; terminal synth `:389`→`:406`;
  `error` `:408`; `action_required` `:346`).
- **Task list (TDD order — tests first):**
  1. **T2.1 (server tests, RED/UPDATE)** — `test/server.test.ts`:
     - **Update** the 5 `type:"done"`-keyed terminal assertions (`:123, :175, :420, :452, :521`) to expect
       the **last** stdout line's `type` to be `"agent_end"`. Where a test reads the terminal payload,
       **additionally** assert a legacy `done` line is present in the stream (dual-emit). The `.at(-1)`
       assertions that check only `session`/`usage` (`:144-145, :219`) stay **unchanged** (canonical
       `agent_end` carries both — they must still pass).
     - **Add AC3 assertions:** a `/run` turn now emits `tool_start`/`tool_end` **with `id`**; given a
       reasoning-emitting mock (`mock.ts` `reasoning`), a `reasoning_delta` line appears; the error-path
       test asserts the `error` line now carries **`where`**; and the terminal is a canonical `agent_end`
       (with `session`) **plus** a legacy `done` line.
  2. **T2.2 (impl — server)** — `src/server.ts` `streamRun`:
     - Replace the inline `subs = [...]` (`:380-388`) hand-rolled handlers with `const subs =
       wireJsonl(write, agent)` (this adds `id` to tool events and adds the `reasoning_delta`
       subscription — both additive) — verify `wireJsonl` covers exactly the six common events and that
       the per-turn dispose in the `finally` still disposes the returned array.
     - Terminal: keep the synthesized terminal from `agent.run()`'s return, but emit **two** lines in
       order — first the legacy line as an **explicit inline object** `write({type:"done", reason,
       session, usage})` (the deprecated shape is frozen and must **not** enter the canonical `eventToJsonl`
       mapper, which holds only the 9 canonical shapes — D1), then `write(eventToJsonl("agent_end",
       {reason, usage, session}))` **last**.
     - `error` (`:408`): the server's error line has **no `where` today** and must gain one — shape via
       `eventToJsonl("error", {where: "agent.run", message})`. The `where` value is a **new** constant the
       server supplies (not a hook value — D3). This `catch` (`server.ts:407`) wraps the **whole** turn
       `try` (`:374`), which covers both the setup window (`agent.restore`, `:378`) and `agent.run`
       (`:389`) — so `where` here is a **single coarse label for the whole catch, not a per-source
       discriminant** (unlike the CLI's hook-forwarded `where`, which is precise per failure site).
       `"agent.run"` is chosen because it labels the **dominant/expected** failure (a provider or tool
       error inside the run) and matches the kernel's own label for that path (`agent.ts:328/337`), so the
       common case reads consistently with the CLI. Note the AC3 fixture (SRV-2b) actually throws from the
       **restore/setup** window, which this coarse label also covers — acceptable because AC3 asserts only
       that `where` is **present** (like SRV-2b checks `message` matches `/boom/`), so the exact value is
       **non-load-bearing**; pinning it to `"agent.run"` just keeps the two front ends
       vocabulary-consistent for the common case. `action_required` (`:346`): shape via
       `eventToJsonl("action_required", {id, question, options})`.
  3. **T2.3 (impl — CLI + its test)** — `src/cli.ts` `wireJsonRendering`:
     - Replace the six common inline handlers with `wireJsonl(emit, agent)`; keep the CLI's own
       `agent_end` (hook-sourced, **no** `session`) and `error` handlers, both shaped via
       `eventToJsonl`. The output must stay **byte-identical** (AC2).
     - `test/cli.test.ts`: **extend** the existing `--json` subprocess test with one assertion — the
       **last** emitted stdout line's `type` is `"agent_end"` (AC2 layer-3). Every other assertion in that
       test stays unchanged.
  4. **T2.4 (AC4 — shared-mapper check)** — a small grep-style test or an inline assertion (in
     `test/jsonl.test.ts` or a new `test/jsonl-adoption.test.ts`) confirming both `src/cli.ts` and
     `src/server.ts` import from `./jsonl.js` and neither still hand-rolls a divergent common-event
     object. (Review-verified + the grep.)
- **Per-task acceptance commands:**
  - `node --import tsx --test test/cli.test.ts test/server.test.ts test/jsonl.test.ts`
- **Exit condition:** those green; `npm test` 0 fail; `npm run typecheck` 0; `npm run typecheck:test` 0;
  `npm run build` 0; `npm run eval` 5/5; `test/kernel-surface.test.ts` green (kernel unchanged).

### Phase 3 — docs: canonical JSONL contract + CHANGELOG + `cli-json.md` note

- **Entry condition:** Phase 2 merged; both front ends share the mapper; the server dual-emits.
- **Design references:** D4. Anchors: `README.md:343` (`/run` line), `docs/design/2026-07-10-cli-json.md:5-7`
  (contract framing) + `:28-29` (JSONL-schema non-goal).
- **Task list:**
  1. **T3.1** — add a "JSONL event schema" section (in `docs/EXTENSIONS.md` or a new `docs/` page,
     cross-linked from README's `/run` line) enumerating the 9 canonical event shapes (now shared by both
     front ends), noting the server-only `session`/`action_required`, and the **`done` → `agent_end`
     deprecation** (the server emits both during the window; consumers should migrate to `agent_end`).
  2. **T3.2** — CHANGELOG entry: flag the additive server changes (`id` on tool events, `reasoning_delta`
     over HTTP, canonical `agent_end` terminal) and the `done` deprecation window.
  3. **T3.3** — update `docs/design/2026-07-10-cli-json.md`'s contract framing (`:5-7`, `:28-29`) to point
     at the new canonical schema doc.
- **Per-task acceptance commands:**
  - `npm run build` (docs are markdown; the gate is that no code/test regressed — run `npm test` as the
    catch-all)
- **Exit condition:** `npm test` 0 fail; `npm run typecheck` 0; `npm run typecheck:test` 0; `npm run build`
  0; `npm run eval` 5/5; the new doc section renders and cross-links resolve (review-verified);
  `test/kernel-surface.test.ts` green.

## 3. Engineering Constraints Index

- **Engineering norms** — CLAUDE.md: ESM `.js` specifiers (`src/jsonl.ts` imports kernel types via
  `./kernel/…​.js`; the front ends import `./jsonl.js`); strict TS (`src/` is typechecked — `eventToJsonl`
  must be precisely typed, no `any`; `test/` typechecked too via `typecheck:test`); **zero kernel change**
  (only `src/jsonl.ts` (new, top-level), `src/cli.ts`, `src/server.ts`, docs, tests); **no new
  dependency**. Comments explain the code, not the workflow (no `// Cycle 7`, no design-doc references).
- **Four-corner template** — `references/loop-3-development.md`.
- **Commit conventions** — `feat(phaseN):` / `fix(phaseN-roundR): <keyword>`; results as trailers; no
  AI/model/tooling mention.

## 4. Data and Fixture Dependencies

- **Phase 1:** the scripted mock agent for the `wireJsonl` golden is a hand-built stub (`{hooks:{on}}`),
  not a real `Agent` — no provider needed. The pre-refactor CLI expected strings are copied verbatim from
  the current `cli.ts:337-346` shapes.
- **Phase 2:** reuse `test/server.test.ts`'s existing `/run` harness + `MockProvider`; the
  reasoning-emitting mock uses `MockProvider`'s `reasoning` field (`mock.ts:79-82`); the error-path
  assertion reuses the existing restore-throw pattern (SRV-2b). Reuse `test/cli.test.ts`'s `runCli`
  subprocess harness.
- All offline (MockProvider), no network, no `ANTHROPIC_API_KEY`.

## 5. Regression Protection

Must stay green:
- **Phase 1:** the entire existing suite (the new module is additive; no front-end change yet).
- **Phase 2:** `test/cli.test.ts` (byte-identical except the one added terminal assertion),
  `test/server.test.ts` (only the 5 `type:"done"` terminal assertions change; `:144-145`/`:219` and all
  non-terminal assertions stay green), and every extension test that hits `/run` or `--json` indirectly.
- **Phase 3:** doc-only — `npm test` as the regression catch-all.
- Final gate each phase: `npm test`, `npm run typecheck`, `npm run typecheck:test`, `npm run build`,
  `npm run eval` (5/5), and `test/kernel-surface.test.ts` (kernel line count unchanged — no `src/kernel/`
  edit anywhere in this cycle).
