# Implementation — Transcript-level information-flow taint for flow-guard

Slug: `2026-06-16-information-flow-taint`
Design: `docs/design/2026-06-16-information-flow-taint.md`
Status: draft

## 1. Task Index

| Design Deliverable / AC | Design doc location | Realized by |
| --- | --- | --- |
| Taint attached to tool-result `Message.meta.flowGuardTaint` | §2 deliverable 1; §4 D1 | I1, I2 |
| Data triggers routed to message taint, removed from session set (Set-split) | §2 deliverable 2; §4 D2; AC4b | I1, I2 |
| Egress gated iff capability-set non-empty OR a live message is tainted | §2 deliverable 3; §4 D2 | I3 |
| Precision: cleared/handed-off transcript un-gates | §2 deliverable 3; AC2 | I3 (+ T1) |
| Capability-chain taint unchanged | §2 deliverable 4; AC4 | I1 (untouched path) |
| `/flow-guard status` shows both counts; `reset` strips message taint | §2 deliverable 5; §4 D3; AC5, AC6 | I4, I5 |
| Zero kernel changes | §2 deliverable 7; AC7 | (none under src/kernel) |
| Acceptance criteria AC1–AC7 | §7 | tests T1–T4 + existing tests + gate commands |

Project commands (CLAUDE.md *common-commands* role, by convention): `<TEST-CMD>` = `npm test`;
typecheck = `npm run typecheck`; build = `npm run build`. All run offline against MockProvider.

## 2. Phase Breakdown

### Phase 1 — Information-flow taint in `flow-guard` (single Phase)

One contiguous block of Deliverables, one file of source (`src/extensions/flow-guard.ts`) plus its
test (`test/flow-guard.test.ts`); independently committable; `npm test` green at exit. Per the
design Scope Boundary, **no other file changes** (host registration already exists; no kernel edit).

**Entry condition:** L1 design passed (`docs/design/2026-06-16-information-flow-taint.md`, round 3
clean). Current `flow-guard.ts` uses a single session `Set` for both capability and data taint.

**Design document references:** §2 (Deliverables), §4 D1/D2/D3, §7 (AC1–AC7), §8 (Risks),
`docs/design/2026-06-16-information-flow-taint.md`.

**Task list, in TDD order** (test tasks first; each names the invariant it protects):

*Test tasks (add to `test/flow-guard.test.ts`):*

- **T1 — "egress is allowed once the tainting tool result leaves the transcript"** (AC2; protects:
  *data-taint follows the data — removing the data from context removes the gate*). Harness in
  `block` mode with a 4-entry responder: run 1 calls `read_file({path:"config/.env"})` (fs:read) then
  ends; assert the egress tool did **not** run if called now (it isn't yet), then `h.agent.clear()`;
  run 2 calls `get_url` (net:fetch) and **must execute** (`fetched === true`). A buggy
  implementation that still populated the sticky set, or that ignored transcript presence, would
  keep gating after `clear()` and fail this test.
- **T2 — "the tool result carrying sensitive data is tagged; a benign result is not"** (AC3;
  protects: *taint is attached to the specific data-bearing message, by provenance*). After a run
  whose `read_file` reads `config/.env`, assert the `tool`-role message in `h.agent.messages` has a
  non-empty `meta.flowGuardTaint` array; after a run whose tool reads a benign path, assert the tool
  message's `meta?.flowGuardTaint` is `undefined`. A shape-only test (e.g. only checking the array
  type) is insufficient — assert the benign case is untagged so the test distinguishes tagged from
  untagged.
- **T3 — "data triggers do not populate the capability-taint set (status shows 0)"** (AC4b, AC5;
  protects: *the Set-split — sensitive path/content no longer make the session sticky*). After a
  `read_file({path:"config/.env"})` run with no `shell:exec` tool, run `/flow-guard status` and
  assert the output reports a **capability-taint count of 0** and a **tainted-data count ≥ 1**.
- **T4 — "/flow-guard reset strips data taint so egress is allowed"** (AC6; protects: *reset is a
  true clear-all lever under information flow*). After a sensitive read taints a live message
  (`block` mode), invoke `/flow-guard reset`, then a `get_url` call **must execute**.

*Implementation tasks (only after T1–T4 exist and fail for the right reason):*

- **I1 — Set-split in the `tool_end` handler.** Stop `tainted.add("sensitive-path")` and
  `tainted.add("sensitive-content")` (`flow-guard.ts:104,110`). Keep `tainted.add(cap)` for
  `sourceCaps`. For a sensitive **path** argument, record `call.id → reasons[]` in a new pending
  `Map<string,string[]>` instead. (Content taint is NOT detected here — it moves to I2.)
- **I2 — `message` handler + pending-map lifecycle.** Add `e.on("message", …)`: for a `role:"tool"`
  message, for each `tool_result` block, collect reasons = (pending[block.toolCallId] ?? []) plus
  `"sensitive-content"` if any `sensitiveContent` regex matches `block.content`; if reasons
  non-empty, set `message.meta = { ...message.meta, flowGuardTaint: reasons }`; delete consumed
  pending entries. Clear the pending map in the existing `session_start`/`session_shutdown` handlers
  alongside `tainted.clear()` (`flow-guard.ts:131-132`).
- **I3 — Egress gate reads live transcript taint.** In the `beforeToolCall` handler, compute
  `dataTainted = e.agent.messages.some(m => Array.isArray((m.meta as any)?.flowGuardTaint) && (m.meta as any).flowGuardTaint.length > 0)`. Gate when `tainted.size > 0 || dataTainted` (replacing the
  current `tainted.size === 0` early-return). Update the `why` string to name the active reason(s).
- **I4 — `/flow-guard status` two counts.** In the `default` case, also compute the tainted-data
  count (messages with a non-empty `flowGuardTaint`) and print both `capability-taint: <n>` and
  `tainted-data: <n>`.
- **I5 — `/flow-guard reset` strips message taint.** In the `reset` case, after `tainted.clear()`,
  iterate `e.agent.messages` and delete `flowGuardTaint` from each `meta` (guard for absent `meta`).

**Per-task acceptance commands** (runnable from repo root):

- T1: `node --import tsx --test --test-name-pattern="leaves the transcript" test/flow-guard.test.ts` → exit 0.
- T2: `node --import tsx --test --test-name-pattern="benign result is not" test/flow-guard.test.ts` → exit 0.
- T3: `node --import tsx --test --test-name-pattern="capability-taint set" test/flow-guard.test.ts` → exit 0.
- T4: `node --import tsx --test --test-name-pattern="reset strips" test/flow-guard.test.ts` → exit 0.
- Whole-extension regression: `node --import tsx --test test/flow-guard.test.ts` → exit 0 (all new + the 6 pre-existing flow-guard tests).
- Gates (AC7): `npm run typecheck` → exit 0; `npm test` → exit 0 (incl. `test/kernel-surface.test.ts`); `npm run build` → exit 0.

**Exit condition:** all six acceptance commands above exit 0; `git diff --stat` shows only
`src/extensions/flow-guard.ts` and `test/flow-guard.test.ts` changed (no `src/kernel/*`).

## 3. Engineering Constraints Index

- **Engineering norms** (CLAUDE.md "House conventions"): ESM with `.js` import specifiers even for
  `.ts`; strict TS (`noUncheckedIndexedAccess` etc. — no `any` cop-outs: prefer a typed
  `meta?.flowGuardTaint` read helper over `as any` where practical, but a localized cast for the
  untyped `meta` bag is acceptable and pre-existing in the codebase, e.g. `memory.ts`); zero runtime
  deps except `jiti`; every extension capability-gated and ships with offline tests; `node:test` via
  `tsx`, must run offline.
- **Four-corner subagent template:** `references/loop-3-development.md`.
- **Commit conventions:** SKILL.md "Commit conventions" — `feat(phase1):` opener,
  `fix(phase1-roundR): <keyword>` for within-round fixes, `<TEST-CMD>`/`<ACCEPT-CMD>` results as
  trailers, no mention of tooling/AI.

## 4. Data and Fixture Dependencies

- Reuse `test/flow-guard.test.ts`'s existing pattern: `makeHarness({fallback:"allow", responder, ui})`
  from `test/helpers.js`, inline `defineTool` source/egress tools, and `e.store.set("mode","block")`
  via the activation wrapper. No new fixtures or files.
- The MockProvider responder is an array indexed by cumulative call count across `agent.run()` calls
  (per `src/providers/mock.ts`), so a multi-run test (T1) supplies one responder entry per turn
  across both runs.
- No network, no API key (offline mandate preserved).

## 5. Regression Protection

These must stay green (run by `node --import tsx --test test/flow-guard.test.ts` and the full
`npm test`):

- The 6 existing `flow-guard` tests, in particular: "blocks network egress after a shell command in
  the same session (block mode)" (capability chain — AC4, unchanged path), and the two
  data-confinement tests (sensitive-path → egress; credential-result → egress) which now pass via the
  **new** message-taint path (egress runs while the tainting tool message is live).
- `test/kernel-surface.test.ts` (no kernel-surface growth).
- The full suite (`npm test`) — no other extension is touched, so no cross-extension regression is
  expected; the run confirms it.
