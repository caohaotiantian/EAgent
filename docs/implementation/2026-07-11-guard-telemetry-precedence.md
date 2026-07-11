# Implementation — Guard telemetry + precedence contract (Cycle 6)

Slug: `2026-07-11-guard-telemetry-precedence` (matches the design)
Status: **closed** (2026-07-11) — L3 single phase via l3-phase.js round 1, PhaseEnd-verified; F review passed zero-severe (one NIT fixed in closeout). See design closure block.

## 1. Task Index

Design: `docs/design/2026-07-11-guard-telemetry-precedence.md`. Deliverables D1–D5 → §2; Acceptance
AC1–AC5 → §7; KDD1–KDD3 → §4; the 17-extension `beforeToolCall` roster → D1/§4. One phase (helper +
two consumers + doc + drift test are one coherent, independently-committable unit). `<TEST-CMD>` =
`npm test`.

## 2. Phase Breakdown

### Phase 1 — guard-block helper + otel/trace telemetry + precedence contract (doc + drift test)

- **Entry condition:** branch `chore/production-hardening`, suite green (baseline 1349 pass / 1 skip);
  kernel 2248/2250.
- **Design references:** §2 D1–D5; §4 KDD1–KDD3; §5 (block site `agent.ts:502-504` + the second
  producer `dynamic-workflow.ts:443`; otel `:227-239/:368-382`; trace `:135-164`; the 17-registrant
  derivation via `bus.listenerCount("beforeToolCall")`, `hooks.ts:148`); §7 AC1–AC5.
- **Task list (TDD order — tests first):**
  1. **T1.1 (tests, RED)** —
     - **`test/guard-block.test.ts`** (AC1): `isGuardBlock({content:"Tool call blocked: flow-guard: x",
       isError:true})` → true; `isGuardBlock({content:"boom", isError:true})` → false;
       `isGuardBlock({content:"ok", isError:false})` → false; `blockReason(...)` returns the text after
       `"Tool call blocked: "`.
     - **`test/otel-exporter.test.ts`** (AC2): script a `beforeToolCall` guard that blocks a tool call →
       assert the exporter's `eagent.guard.blocks` metric is 1 AND the existing `eagent.tool.calls`
       `error=true` count still reflects it (block counts as error there too — additive); a **real**
       `fail:true` tool error → `guard.blocks` stays 0. Assert the tool span carries
       `eagent.guard.blocked=true` + a reason attribute. **The existing `error=true/false` assertions
       (`:574-575,:934-935`) must stay green.**
     - **`test/trace.test.ts`** (AC3): a guard-blocked call → the `/trace` readout shows a `blocked`
       count AND leaves `toolErrors` at **0** (trace shows a block as `blocked`, NOT `errors` — this is
       deliberately different from otel, which keeps a block additively in `error`); a real tool error →
       `errors` (and `blocked` 0). **Assert `toolErrors===0` on the block case** so the test can't pass
       with a block double-counting into errors.
     - **`test/guard-precedence.test.ts`** (AC4 drift guard): build a fresh host, activate
       `BUILTIN_EXTENSIONS` **incrementally**, recording which extension grows
       `agent.hooks.listenerCount("beforeToolCall")` by 1 (`hooks.ts:148`), and assert the resulting
       ordered name list **equals** the documented roster (the 17 in §2 D1). RED if the doc drifts.
  2. **T1.2 (impl — telemetry)** —
     - **`src/extensions/lib/guard-block.ts`** (new): `export const GUARD_BLOCK_PREFIX = "Tool call
       blocked: ";` with a comment naming BOTH producer sites (`agent.ts:503`, `dynamic-workflow.ts:443`)
       as co-maintenance, and noting it reads the **post-`afterToolCall`** `tool_end` result (the prefix
       leads the string; current `afterToolCall` filters only append/skip a block, never prepend, so
       detection is robust — #4); `export function isGuardBlock(result: ToolResult): boolean`
       (`!!result.isError && typeof result.content === "string" && result.content.startsWith(
       GUARD_BLOCK_PREFIX)`); `export function blockReason(result: ToolResult): string` (the slice after
       the prefix).
     - **`src/extensions/otel-exporter.ts`**: `import { isGuardBlock, blockReason } from
       "./lib/guard-block.js";`. Add a `guardBlocks` accumulator next to `const toolCalls = { ok:0,
       error:0 }` at **`:157`**; in the `tool_end` handler (`:368`), when `isGuardBlock(result)` increment
       it AND set the span attributes `eagent.guard.blocked=true` + `eagent.guard.reason=blockReason(
       result)` (do NOT change the existing `toolCalls[isError?...]++` at `:371`). In the metric flush
       (`:227-239`), push an `eagent.guard.blocks` sum metric gated on `guardBlocks>0` — note `sumPoint`
       (`:208-213`) hard-codes exactly one attribute, so for a dimensionless count either pass a nominal
       attr (e.g. `attr("kind","guard-block")`) or build the data point inline (#3). `result` is already
       typed `ToolResult` (no widening needed here).
     - **`src/extensions/trace.ts`**: `import { isGuardBlock } from "./lib/guard-block.js";`. **Widen**
       the inline `tool_end` payload type (`:151`) to include `content: string` (it currently types
       `result: { isError?: boolean }`); add a `toolBlocked` counter incremented when
       `isGuardBlock(result)` (instead of / in addition to the `toolErrors` bump — a block is shown as
       `blocked`, not `errors`); surface it in the `/trace` readout.
  3. **T1.3 (impl — precedence doc)** — add a "**Guard precedence**" subsection to `SECURITY.md` (near
     the guard/hardened content) documenting: the 17-extension `beforeToolCall` order (D1 roster,
     re-derived from `host.ts` at implementation), **first `block:true` wins** (`agent.ts:500`), **rewrite
     chains onward**, **no priority mechanism** (reorder `BUILTIN_EXTENSIONS` to change precedence). Add a
     one-line cross-link from `docs/EXTENSIONS.md`'s `beforeToolCall` section. CHANGELOG entry (note the
     additive `eagent.guard.blocks` metric + the precedence contract).
- **Per-task acceptance commands:**
  - `node --import tsx --test test/guard-block.test.ts test/otel-exporter.test.ts test/trace.test.ts test/guard-precedence.test.ts`
- **Exit condition:** those green; `npm test` 0 fail; `npm run typecheck` 0; `npm run typecheck:test` 0;
  `npm run build` 0; `npm run eval` 5/5; `test/kernel-surface.test.ts` green (kernel line count
  **unchanged** — no `src/kernel/` edit).

## 3. Engineering Constraints Index

- **Engineering norms** — CLAUDE.md: ESM `.js` specifiers (the new `./lib/guard-block.js` import);
  strict TS (`src/` is typechecked — the `trace.ts` inline-type widening must compile; `test/` now
  typechecked too via `typecheck:test`); a helper shared by two extensions goes in `lib/` (not imported
  peer-to-peer); **zero kernel change** (only `otel-exporter`/`trace`/`lib`/docs/tests). No new
  capability; the telemetry rides `otel-exporter`/`trace`, which have their own kill switches.
- **Four-corner template** — `references/loop-3-development.md`.
- **Commit conventions** — `feat(phaseN):` / `fix(phaseN-roundR): <keyword>`; results as trailers; no
  AI/model/tooling mention.

## 4. Data and Fixture Dependencies

- Reuse `test/otel-exporter.test.ts`'s existing exporter harness + the `ping{fail:true}` error fixture
  (for the "real error stays error" case) and add a blocking `beforeToolCall` guard fixture (a tiny test
  extension returning `{block:true, reason:"...", arguments}`). Reuse `test/trace.test.ts`'s harness.
  `test/guard-precedence.test.ts` uses `BUILTIN_EXTENSIONS` + a fresh host + `hooks.listenerCount`. All
  offline.

## 5. Regression Protection

Must stay green:
- `test/otel-exporter.test.ts` (the existing `eagent.tool.calls` `error=true/false` assertions — the
  metric is UNCHANGED, additive counter only), `test/trace.test.ts`, `test/circuit-breaker.test.ts` (it
  asserts on `"Tool call blocked"` strings — confirm the helper doesn't change any produced string),
  `test/dynamic-workflow.test.ts` (its `guardedBody` block string is untouched — the helper only
  *reads*, never produces).
- Full suite `npm test`; final gate adds `npm run eval` (5/5), `npm run build`, `npm run typecheck:test`,
  and `test/kernel-surface.test.ts` (kernel unchanged).
