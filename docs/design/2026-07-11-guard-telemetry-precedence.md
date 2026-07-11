# Design — Guard telemetry + precedence contract (Cycle 6)

Slug: `2026-07-11-guard-telemetry-precedence`
Status: **closed** (2026-07-11)
Closing-commits: Cycle-6 docs commit, `337f671` (impl), + this closeout (F-review NIT: strip 3 `(KDD2)`
design-decision markers from `otel-exporter.ts` comments — house rule "comments explain the code, not
the workflow").
Result: suite 1349→1364 pass / 0 fail / 1 skip; typecheck 0; typecheck:test 0; build 0; eval 5/5;
**kernel unchanged** (zero-kernel). L1 2 rounds (severe→zero-severe, roster independently re-derived) /
L2 1 round PASS / L3 1 phase / F — all zero-severe. Delivered: `lib/guard-block.ts` + otel `eagent.guard.blocks`
additive counter + trace `toolBlocked` + SECURITY.md precedence contract + a live drift-guard test.

## 1. Background and Purpose

The `beforeToolCall` guards block/rewrite tool calls but leave two gaps:

- **No precedence contract.** Guards run as `beforeToolCall` filters in `BUILTIN_EXTENSIONS` load order
  (`src/kernel/hooks.ts:141-145` iterate in registration order), and the **first `block:true`
  short-circuits** the rest (`shouldStop = (d)=>d.block`, `src/kernel/agent.ts:500`; a non-block
  *rewrite* chains onward). There is **no priority mechanism** and this order is documented nowhere — an
  extension author or operator can't reason about which guard wins.
- **No guard-block telemetry.** On a block the dispatcher returns a bare error result
  `{ content: "Tool call blocked: <reason>", isError: true }` (`src/kernel/agent.ts:502-504`) and emits
  no dedicated event; the block *is* observable on `tool_end` but only as a **generic `isError` result**,
  indistinguishable from an ordinary tool error. `otel-exporter` buckets it as `error`
  (`src/extensions/otel-exporter.ts:371`); `trace` counts it as a tool error (`src/extensions/trace.ts:152`).

The user chose (2026-07-11) the **zero-kernel** telemetry path (charter: "new behavior is an extension,
never a fork of the core"; kernel has ~1–2 lines of slack, no bump). The one free, reliable signal is
the dispatcher's consistent `"Tool call blocked: "` prefix on the `tool_end` error result.

## 2. Deliverables

- [ ] **D1 (precedence contract, docs + drift test)** — a new "Guard precedence" subsection in
      `SECURITY.md` documenting: (a) guards run as `beforeToolCall` filters in **`BUILTIN_EXTENSIONS`
      load order** = the first-block-wins precedence order. The **full `beforeToolCall` set is 17
      extensions** (every `e.hook("beforeToolCall")` registrant, in `host.ts` array order — NOT the 10
      "guards", and NOT `content-guard`, which is `afterToolCall`):
      **`templates` → `provenance` → `circuit-breaker` → `planmode` → `limits` → `budget-cap` →
      `checkpoint` → `flow-guard` → `risk-guard` → `headless-flags` → `bash-policy` → `sandbox-tiers` →
      `config-hooks` → `write-guard` → `secret-guard` → `skills-hardening` → `self-extend-floor`**
      (L3 re-derives this from `host.ts` via `grep -l 'e.hook("beforeToolCall"' src/extensions/*.ts`
      intersected with the array order, so the doc is source-derived, not hand-listed). (b) **first
      `block:true` wins** — later filters are skipped (`agent.ts:500`); (c) a non-block **rewrite chains
      onward**; (d) **no priority mechanism** — to change precedence, reorder `BUILTIN_EXTENSIONS`.
      Cross-link from `docs/EXTENSIONS.md`'s `beforeToolCall` section. **Plus a drift-guard test** (G2):
      a `test/guard-precedence.test.ts` asserting the SECURITY.md-documented order **equals** the live
      `beforeToolCall` registrant order derived from `BUILTIN_EXTENSIONS`, so a future reorder/add fails
      loudly instead of silently drifting.
- [ ] **D2 (guard-block detection helper)** — a small shared `src/extensions/lib/guard-block.ts`
      exporting `isGuardBlock(result: ToolResult): boolean` (a `result.isError` + `content` starts with
      the `"Tool call blocked: "` prefix) and `blockReason(result): string` (the text after the prefix).
      One place owns the coupling to the kernel's block-message format (`agent.ts:503`), with a comment
      naming that source; `otel-exporter` and `trace` both import it (no duplicated string).
- [ ] **D3 (otel-exporter telemetry)** — on `tool_end`, when `isGuardBlock(result)`, increment a new,
      **additive** `eagent.guard.blocks` counter (a guard block is thus broken out) — **leaving the
      existing `eagent.tool.calls` `error=true/false` bucketing UNCHANGED** (a block still counts as an
      error there, which is accurate, so no existing metric is reclassified and the current
      `test/otel-exporter.test.ts` `error` assertions stay green — C1). Also set on the tool **span**
      `eagent.guard.blocked=true` + `eagent.guard.reason=<blockReason>` (the reason often names the guard;
      it goes on the low-frequency *span*, not the metric, to avoid metric cardinality blow-up).
- [ ] **D4 (trace telemetry)** — `trace` distinguishes a guard block from a tool error in its readout
      (a `blocked` count separate from `errors`), so `/trace` shows guard blocks distinctly.
- [ ] **D5 (tests + docs)** — a guard-blocked `tool_end` is recorded as a **block** (not a generic error)
      by both otel-exporter and trace; a real tool error is still counted as `error`; `isGuardBlock` is
      unit-tested against the exact kernel prefix. CHANGELOG entry.

## 3. Scope Boundary (NOT in scope)

- **No kernel change** (user decision). No new `KernelEvents` entry, no `ToolDecision.by` field. The
  telemetry keys off the existing dispatcher block-message prefix on `tool_end` — a zero-kernel signal.
- **Not reliable which-guard attribution.** The block *reason* (captured on the span) often names the
  guard, but attribution is **best-effort text**, not structural. Documented (§8 R1); structural
  attribution (a `ToolDecision.by` field) is a deferred follow-up if reliable per-guard metrics are
  later needed.
- **Not changing guard behavior or the block message** — guards and the dispatcher are untouched; this
  cycle only *observes* + *documents*. (The `"Tool call blocked: "` prefix is treated as a stable
  contract with two byte-identical producers — `agent.ts:503` + the `dynamic-workflow.ts:443` mirror
  (§5); only the dispatcher reaches telemetry, and `guard-block.ts` isolates the *detection* while its
  comment flags both string sites for co-maintenance — R2.)
- **Not adding a priority mechanism** to the hook bus — the contract *documents* load-order precedence;
  it does not add a priority field (that would be a kernel change, out of scope).
- **No new capability / kill switch** — this rides `otel-exporter`/`trace`, which have their own
  `EAGENT_<NAME>=off`; the enhancement is inert when they are.

## 4. Key Design Decisions

### KDD1 — telemetry via the dispatcher's block-message prefix, in a shared lib helper
- **Problem:** how to detect a guard block on `tool_end` with zero kernel change.
- **Options:** (a) each consumer (otel, trace) inlines the `"Tool call blocked:"` prefix check;
  (b) a shared `lib/guard-block.ts` helper; (c) a kernel event/field (rejected by the user decision).
- **Choice: (b).** The prefix is the kernel's block-message format (`agent.ts:503`) — a coupling that
  should live in **one** place with a comment naming its source, so a future kernel message change is a
  one-line fix, not a hunt across consumers. (a) duplicates the brittle string; (c) is the rejected
  kernel path.

### KDD2 — an additive `eagent.guard.blocks` counter (not reclassify the tool-calls metric), reason on the span
- **Problem:** where does the block signal live in otel — reclassify the existing metric vs a new metric
  vs span attribute?
- **Choice:** a **new additive `eagent.guard.blocks` counter** + the free-text **reason on the span** (a
  per-call attribute, not aggregated). Rejected: **reclassifying** the existing `eagent.tool.calls`
  `error` bucket into `ok/error/blocked` (a semantic reclassification that moves blocks out of `error`,
  breaking any dashboard/test keying on the `error` attribute — the current otel tests assert exact
  `error=true/false` counts); the additive counter keeps the existing metric byte-stable while still
  breaking blocks out. Also rejected: a `reason`/`guard` **metric** label (unbounded cardinality → metric
  explosion) — the reason belongs on the low-frequency span.

### KDD3 — precedence contract in SECURITY.md, documenting the FULL beforeToolCall set
- **Problem:** where to document precedence, and which extensions to name.
- **Choice:** a SECURITY.md subsection (it owns the guard/hardened narrative) naming the **full**
  `beforeToolCall` set (~17), not just the 10 "guards" — because provenance/checkpoint/config-hooks/etc.
  also ride the seam and participate in precedence; naming only 10 would under-state who wins. Rejected:
  a docs/ standalone (SECURITY.md is the discoverable home) and a 10-guard-only list (inaccurate).

## 5. Dependencies and Assumptions

Verbatim source:
- Block site: `agent.ts:502-504` `if (decided.block) return { content: \`Tool call blocked: ${decided.reason
  ?? "no reason given"}\`, isError: true }`. Short-circuit: `agent.ts:500` `(d)=>d.block`;
  `hooks.ts:141-145`. `tool_end` emitted at `agent.ts:480` with `{ call, result, step }`.
- `ToolResult` shape `types.ts:128-139` (`content`, `isError`, `details`, `terminate` — no `meta`);
  `content` is a string for a block result.
- otel tool metric `otel-exporter.ts:227-239` (`eagent.tool.calls`, `error` bool dim), `tool_end`
  handler `:368-382` (buckets by `result.isError` at `:371`), span `tool_start`/`tool_end` `:349-382`.
- `trace` `tool_end` `trace.ts:135-164`, error bucket `:152`.
- Guard order in `host.ts` `BUILTIN_EXTENSIONS` (`:98-162`) — the doc lists the current order (a fresh
  read at L3 confirms the exact sequence, since prior cycles reordered it; e.g. watchdog was added).
- **Assumption (corrected — TWO producers, not one):** the `"Tool call blocked: "` string is produced at
  **two** byte-identical sites — the dispatcher `agent.ts:503` (the telemetry source) AND
  `dynamic-workflow.ts:443` (`guardedBody`, which deliberately mirrors the kernel guard sequence). The
  workflow mirror emits **no `tool_start`/`tool_end`** (`guardedInvoke`, `dynamic-workflow.ts:426-434`),
  so its blocks never reach the otel/trace `tool_end` handlers — they are **out of telemetry scope** (no
  false positives from that path). So the coupling to the block-string format is a **co-maintenance of
  two literals** (`agent.ts:503`, `dynamic-workflow.ts:443`) plus the `guard-block.ts` helper; AC1 pins
  the helper's copy, and `guard-block.ts`'s comment names both producer sites so a future kernel
  message change is a known 3-point update (broken loudly by AC1, R2).
- Suite offline; a guard-blocked `tool_end` is producible by scripting a `beforeToolCall` guard that
  blocks (reuse an existing guard test's block path, or a tiny test guard).
- **Impl note (L3):** only `trace.ts:151` inline-types the `tool_end` payload as `{ …; result: {
  isError?: boolean } }`, so its read must widen to include `content: string` for `isGuardBlock(result)`.
  `otel-exporter.ts:368` is `e.on("tool_end", ({ call, result }) => …)` with **no** inline annotation —
  `result` is inferred as `ToolResult` (whose `content` is already `string`, `types.ts:129`) — so otel
  needs **no** widening.

## 6. Relationship with Existing Designs

- No conflict. Builds on the guard set hardened in Cycles 1–2 and the SECURITY.md deployment/hardened
  sections. `otel-exporter`/`trace` are the existing telemetry consumers this extends. Terminology
  anchors: CLAUDE.md (hook bus, `beforeToolCall`, the guard vocabulary), `docs/EXTENSIONS.md`.

## 7. Acceptance Criteria (measurable / automatable)

Offline, in `test/otel-exporter.test.ts`, `test/trace.test.ts`, and a new `test/guard-block.test.ts`.

- **AC1 (`isGuardBlock` unit):** `isGuardBlock({content:"Tool call blocked: flow-guard: …", isError:true})`
  → true; `isGuardBlock({content:"boom", isError:true})` (a real tool error) → false;
  `isGuardBlock({content:"ok", isError:false})` → false. `blockReason` returns the text after the prefix.
  RED before D2.
- **AC2 (otel distinguishes a block):** a guard-blocked tool call → the new `eagent.guard.blocks` counter
  increments **and the existing `eagent.tool.calls` `error=true` count is unchanged** (block still counts
  as an error there — additive, not reclassified); the span carries `eagent.guard.blocked=true` + a
  `reason` attribute. A **real** tool error → increments `error` only, NOT `guard.blocks`. The existing
  `test/otel-exporter.test.ts` `error=true/false` assertions stay green. RED before D3.
- **AC3 (trace distinguishes a block):** a guard-blocked call → `trace`'s readout shows it as a `blocked`
  count, separate from `errors`; a real tool error → `errors`. RED before D4.
- **AC4 (precedence contract present + accurate + drift-guarded):** SECURITY.md has a "Guard precedence"
  subsection listing the `beforeToolCall` order, first-block-wins + rewrite-chains + no-priority, with a
  `docs/EXTENSIONS.md` cross-link (review-verified). **Plus a mechanical drift guard (G2):**
  `test/guard-precedence.test.ts` asserts the documented order **equals** the live `beforeToolCall`
  registrant order derived from `BUILTIN_EXTENSIONS`. **Derivation mechanism (the bus stores no filter
  name, `hooks.ts:116`):** activate `BUILTIN_EXTENSIONS` one at a time onto a fresh host and record which
  activation grows `bus.listenerCount("beforeToolCall")` (public, `hooks.ts:148`) — all 17 register once
  unconditionally at `activate()`, so the count grows by exactly 1 → a deterministic 1:1 name↔registrant
  order. A future reorder/add fails the test loudly rather than silently drifting the doc.
- **AC5 (gates + zero kernel):** `npm test` 0 fail; `npm run typecheck` 0; `npm run typecheck:test` 0;
  `npm run build` 0; `npm run eval` 5/5; `test/kernel-surface.test.ts` green with the kernel line count
  **unchanged** (no `src/kernel/` edit).

## 8. Risks and Rollback

- **R1 — best-effort which-guard.** The span `reason` names the guard only when the guard prefixes its
  reason (inconsistent across guards). Documented as best-effort; the `eagent.guard.blocks` counter
  (which reliably counts *that* a block happened) is the primary signal. Rollback: n/a (additive).
- **R2 — coupling to the kernel block-message prefix (2 producers).** If the kernel changes
  `"Tool call blocked: "`, the telemetry stops detecting blocks. Mitigation: detection lives in one
  helper (`guard-block.ts`) whose comment names **both** producer sites (`agent.ts:503`,
  `dynamic-workflow.ts:443`, §5), and AC1 pins the exact prefix — so a kernel message change breaks AC1
  **loudly** (fast signal), not silently. Rollback: update the helper.
- **R3 — false positive: a non-guard tool returning `isError:true` content that begins with
  `"Tool call blocked: "`.** `isGuardBlock` is a string-sniff, so an echo/reporting tool could in
  principle be miscounted as a block. Probability is low (the prefix is distinctive and tool errors
  rarely start with it), and the impact is a mis-labeled telemetry data point (never a behavior change).
  Documented; accepted as the inherent cost of the zero-kernel signal. (Structural attribution via a
  `ToolDecision.by` kernel field — the rejected Cycle-6 alternative — is the follow-up if this ever
  bites.) The existing `eagent.tool.calls` metric is **unchanged** (additive counter, KDD2), so no
  dashboard reclassification and no otel-test breakage.
- **Overall rollback:** revert the `otel-exporter`/`trace`/`guard-block.ts`/test hunks + the SECURITY.md/
  EXTENSIONS.md doc; each independent. Branch `chore/production-hardening` (PR #40), not merged.
