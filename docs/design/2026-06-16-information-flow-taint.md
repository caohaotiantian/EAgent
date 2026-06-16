# Design — Transcript-level information-flow taint for flow-guard

Slug: `2026-06-16-information-flow-taint`
Status: closed
Closing-commit: 73f9609
Closed-on: 2026-06-16
Deferred: none

## 1. Background and Purpose

`flow-guard` (the compositional capability-policy extension) currently tracks taint as a
**session-sticky `Set<string>`**: once a sensitive capability (`shell:exec`), a sensitive *path*
read (`.env`, `id_rsa`, …), or a credential-looking *result* is seen, the session is tainted and
*every* later network-egress call (`net:fetch`) is gated for the rest of the session
(`src/extensions/flow-guard.ts:86`, `:94-111`, `:114-128`).

This is imprecise for the **data-confinement** case. If the sensitive data leaves the context — the
user runs `/clear` or `/handoff` to start a fresh topic — the session flag stays set, so unrelated
later egress is still gated (false positive). Conversely, the taint is not attached to the *data*,
so it cannot record *which* tool result carried the secret, and it does not travel with a saved /
loaded transcript.

This task upgrades the **data-confinement** taint from a session flag to **information flow**: taint
is attached to the specific tool-result message that carried sensitive data, and egress is gated
**iff a tainted message is still present in the live transcript**. This delivers the property the
research named (`docs/RESEARCH-agent-kernel-design.md` §3, "data confinement") and the forward-agenda
item 2 in `docs/REDESIGN-NOTES.md` §4.

If we do not do this: `flow-guard`'s data-confinement remains a blunt session flag — correct but
noisy after a context reset, and unable to say what tainted the session.

## 2. Deliverables

- [x] Data-confinement taint is **attached to the tool-result message** that carried sensitive data,
      via the kernel's `Message.meta` escape hatch under a namespaced key (`flowGuardTaint`).
- [x] **The data-confinement triggers (sensitive path / sensitive content) are routed ONLY to
      message taint and are no longer added to the session capability-taint set.** After this change
      the session set holds *only* `sourceCaps` (e.g. `shell:exec`). This split is the load-bearing
      transformation: leaving the old `tainted.add("sensitive-path"|"sensitive-content")` lines
      (`src/extensions/flow-guard.ts:104,110`) in place would keep gating after `/clear` and defeat
      the new precision (AC2).
- [x] Egress (`net:fetch`) is gated **iff** the session capability-taint set is non-empty **OR** a
      message currently in `e.agent.messages` carries `meta.flowGuardTaint`.
- [x] After the tainting message leaves the transcript (`agent.clear()` via `/clear` or `/handoff`),
      a subsequent egress is **allowed** (the new precision), with no other change in behavior.
- [x] The capability-chain taint (`shell:exec` → egress) remains a session-sticky set, unchanged.
- [x] `/flow-guard status` reports **both** counts separately — the capability-taint set size and the
      number of tainted messages currently in the transcript — so the Set-split is directly
      observable. `/flow-guard reset` clears the session set and strips `flowGuardTaint` from current
      transcript messages.
- [x] Offline `node:test` coverage for the new behaviors; existing `flow-guard` tests still pass.
- [x] Zero kernel changes — `test/kernel-surface.test.ts` still passes (it pins the kernel export
      list and a source-line ceiling; nothing is added under `src/kernel/`).

## 3. Scope Boundary (NOT in scope)

- **No kernel/core changes.** No new kernel export, event, or type. Implemented entirely inside
  `src/extensions/flow-guard.ts` using existing primitives (`tool_end`, `message`, `beforeToolCall`,
  `e.agent.messages`, `Message.meta`).
- **Capability-chain taint behavior is unchanged.** `shell:exec` (and any configured `sourceCaps`)
  remain session-sticky; this task does not make authority-taint information-flow-precise (an agent
  that ran a shell could carry a secret in any unscannable form — sticky is the conservative choice).
- **Memory-compaction awareness is out of scope.** We check `e.agent.messages` (the persistent
  transcript), not the `transformContext`-summarized context. A message compacted out of the *sent*
  context but still in the transcript still gates (conservative). Precision is delivered for
  `/clear` and `/handoff` (which empty the transcript), not for summarization.
- **No new sensitive-data patterns.** Reuse the existing `sensitivePaths` / `sensitiveContent`
  patterns and their store overrides.
- **Only tool-result messages are tainted.** A user pasting a secret into a prompt, or an assistant
  echoing one, is not tracked. Tool results are the data-ingress boundary flow-guard already watches.
- **No new egress channels.** Only `egressCaps` (default `net:fetch`) are gated, as today.

## 4. Key Design Decisions

### D1 — How is data-taint represented and propagated?

**Problem:** make egress gating depend on whether sensitive data is *present in the current
context*, and record *which* tool result carried it.

- **Option A (chosen): tag the tool-result `Message.meta.flowGuardTaint`.** When a tool result is
  sensitive (matching path or content), set a namespaced taint array on the message that carries it.
  At egress, gate iff any message in `e.agent.messages` carries that key.
  - *Why:* `Message.meta` is the kernel's documented, provider-invisible escape hatch
    (`src/kernel/types.ts:60-71`) — zero kernel change. Taint travels **with the data**: it is
    dropped exactly when the message is (`/clear`, `/handoff` empty `#messages`), and it **survives
    save/load and journaling** because those `JSON.stringify` the message including `meta`
    (`src/extensions/session.ts:89-94`, `src/extensions/journal.ts:38`). It records provenance
    (the reasons array), which the ask requires ("track which tool results carried sensitive data").
- **Option B (rejected): keep a parallel `Set<toolCallId>` of tainted results.** Same gating power,
  but the set can desync from the transcript — a session `/load` restores messages the set never saw,
  so a re-loaded secret would not re-taint. Taint must live *on* the data to be information flow.
- **Option C (rejected): re-scan the whole transcript content at every egress, store nothing.**
  Simpler (no message handler, no meta) and survives `/clear`, but it is **content-only**: a
  sensitive *path* whose file content does not match a known credential pattern (e.g. a plaintext
  config token) would never be caught, and it records no provenance — failing the "track which tool
  result" half of the ask. It also re-scans on every egress. *Named here as the simpler fallback if
  path-based propagation is later judged unnecessary.*

### D2 — Where is taint detected, given the path argument and the message are in different events?

**Problem:** path-based taint needs the *tool call arguments* (available in `tool_end` as
`call.arguments`), but the message to tag is built and emitted later (the aggregated `tool` message
in the `message` event). Content-based taint can be read from the message directly.

- **Chosen:** the two triggers move to *different* mechanisms because their inputs live in different
  events. **Path** taint (needs `call.arguments`, only in `tool_end`) is recorded as the sensitive
  **call ids** in a small pending map (`Map<toolCallId, reasons>`). **Content** taint (needs only the
  result text) is detected directly in the `message` handler by scanning each `tool_result` block's
  `content`. When a `tool` message is appended, the `message` handler tags `meta.flowGuardTaint` for
  any block whose `toolCallId` is pending **or** whose content matches, then consumes the pending
  entry. Reuses two verified facts: the emitted `tool` message is the same object pushed to the
  transcript (`src/kernel/agent.ts:202-203`), and `ToolResultBlock` carries `toolCallId`
  (`types.ts:28-34`).
- **Pending-map lifecycle (specified, not left to the implementer):** the pending map is cleared on
  `session_start` and `session_shutdown` alongside the capability-taint set (mirroring the existing
  `tainted.clear()` handlers at `flow-guard.ts:131-132`), and each entry is consumed when its tool
  message is appended. A pending entry left by a `tool_end` whose tool message is never appended
  (e.g. an aborted turn) is inert (it only gates if a *later, present* message references its id,
  which cannot happen) and is reclaimed at the next session reset — so the map cannot grow unbounded.
- **Rejected:** doing everything in `tool_end` and trying to find/tag the not-yet-built message —
  impossible (the message does not exist yet) and would require buffering raw results.

### D3 — What does `/flow-guard reset` do under information flow?

**Problem:** the old `reset` cleared one `Set`. Now taint also lives on messages in the transcript.

- **Chosen:** `reset` clears the capability-taint set **and** strips `meta.flowGuardTaint` from every
  message currently in `e.agent.messages` (the array is `readonly`, but the `Message` objects'
  `meta` is mutable). This makes `reset` a true "I vouch for this — clear all taint" lever.
- **Rejected:** clearing only the set (leaves tagged messages gating egress, so `reset` would not
  actually un-gate — surprising).

## 5. Dependencies and Assumptions

- **Kernel primitives used (all existing):** `e.on("tool_end" | "message" | "session_start" |
  "session_shutdown")`, `e.hook("beforeToolCall")`, `e.agent.tools.get().capabilities`,
  `e.agent.messages`, `Message.meta`, `ToolResultBlock.toolCallId`.
- **Assumption (verified):** the `message` event hands the same `Message` object that is stored in
  `e.agent.messages`, so tagging its `meta` persists — the tool message is pushed then emitted by
  reference (`src/kernel/agent.ts:202-203`; assistant messages likewise at `:172-173`).
- **Assumption (verified):** `Message.meta` is ignored by providers and preserved through the loop
  and through session/journal `JSON.stringify` (`types.ts:60-71`, `session.ts`, `journal.ts`).
- **Assumption:** `agent.clear()` empties `#messages` (so `/clear`, `/handoff` drop tainted
  messages) — confirmed `src/kernel/agent.ts:136-138`.
- No new runtime dependencies (jiti only, unchanged).

## 6. Relationship with Existing Designs

This is the **first** `docs/design/*.md` for the project (the directory was created for this task);
there is no prior design document to map against. Terminology anchors are `CLAUDE.md` (the project
orientation/contract doc) and the existing prose docs `docs/RESEARCH-agent-kernel-design.md` (§3,
"data confinement", and the four-property model) and `docs/REDESIGN-NOTES.md` (§2 table "Data
confinement" row; §4 forward-agenda item 2), whose terms ("taint", "data confinement", "egress",
"flow-guard") this design reuses verbatim. No conflicts: this task implements the "remaining" work
those docs explicitly defer. Source code of record is `src/extensions/flow-guard.ts` (modified) and
its test `test/flow-guard.test.ts` (extended).

⚠ Consistency note: `CLAUDE.md` describes `flow-guard` as "blocks read→egress chains" — still
accurate after this change (the chain detection is refined, not removed). No CLAUDE.md rule changes;
only the extension's internal taint model changes. The one-line `flow-guard` entry stays correct.

## 7. Acceptance Criteria (measurable / automatable)

Realized as `node:test` cases in `test/flow-guard.test.ts` unless noted; all run offline.

- **AC1 (preserved):** in `block` mode, reading a sensitive path (`config/.env`) then calling a
  `net:fetch` tool in the same turn-chain is blocked (the egress tool's `execute` never runs).
- **AC2 (new precision):** same as AC1, but after `agent.clear()` removes the tainting tool message
  from the transcript, a subsequent `net:fetch` call **is allowed** (egress tool runs).
- **AC3 (tagging):** after a sensitive tool result is appended, the corresponding `tool` message in
  `agent.messages` has `meta.flowGuardTaint` set to a non-empty array; a benign tool result leaves
  `meta?.flowGuardTaint` undefined.
- **AC4 (capability chain unchanged):** `shell:exec` then `net:fetch` is still blocked in `block`
  mode (existing test "blocks network egress after a shell command in the same session (block mode)",
  `test/flow-guard.test.ts`, continues to pass unmodified). Note: the two existing data-confinement
  tests (sensitive-path read → egress; credential-result → egress) also keep passing, but now via the
  *new* message-taint path — they run egress while the tainting tool message is still live in the
  transcript, so message-taint gates exactly where the old session set did.
- **AC4b (Set-split, directly observable):** after a sensitive-path/content read with no `sourceCaps`
  tool, `/flow-guard status` reports a capability-taint count of 0 (the data trigger no longer
  populates the sticky set); gating in that scenario comes *only* from message taint. This is a
  direct assertion on the split, independent of AC2.
- **AC5 (status):** `/flow-guard status` output reports both a capability-taint count and a
  tainted-data (tainted-message) count; the latter is non-zero when a tainted message is in context.
- **AC6 (reset):** with a tainted message in context, `/flow-guard reset` then a `net:fetch` call is
  allowed (taint stripped from current messages).
- **AC7 (gates):** `npm test` exits 0 (all suites, including `test/kernel-surface.test.ts`),
  `npm run typecheck` exits 0, `npm run build` exits 0.

  **Quality budget (declared, bounded — not excluded):** the change adds work in two places: a new
  `message` handler that runs on *every* appended message (user/assistant/tool —
  `src/kernel/agent.ts:154,173,203`), and an O(number-of-messages) `meta` scan inside the existing
  `beforeToolCall` egress gate. The bound: the `message` handler does only constant-work regex
  matching on tool-result text it already had to compute, adds **no** model calls, and the egress
  scan is a boolean `meta` check over a compaction-bounded transcript. Budget = "no added LLM round
  trips and no super-linear transcript work"; verified by AC1-AC6 running offline against the mock.

## 8. Risks and Rollback

- **Risk — meta key collision with another extension.** *Mitigation:* a single namespaced key
  `flowGuardTaint`; no other extension uses it (grep-verifiable). *Rollback:* revert one file.
- **Risk — heuristic patterns miss a secret (false confidence).** Unchanged from today; documented as
  defense-in-depth, not a guarantee. Out of scope to improve patterns here.
- **Risk — performance: scanning the transcript at egress.** O(number of messages) boolean meta
  check; egress is rare and transcripts are compaction-bounded. No measurable hot-path impact.
- **Risk — tagging mutates a transcript message object.** It only sets a namespaced `meta` key the
  kernel ignores; it does not alter `role`/`content`. Confined to flow-guard.
- **Risk — taint metadata persisted in session/journal files.** It records *that* a message was
  sensitive, not new secret bytes; the secret content was already in those files. Acceptable.
- **Risk — `/handoff` un-gates even if its summary echoes a secret.** `/handoff` (`session.ts:178-184`)
  drops the tainting tool message and seeds a model-written `system` summary, so the meta-based gate
  correctly un-gates — but that summary could echo a secret in prose, which §3 leaves out of taint
  scope. This is a deliberate precision-vs-safety trade-off relative to today's sticky flag (which
  would keep gating): it follows the information-flow model (taint tracks tool-result *data*, not
  derived prose). **Accepted and recorded here.** A user who wants the conservative behavior across a
  handoff can leave `flow-guard` in `block` mode and re-run a sensitive read, or not `/handoff` mid-task.
- **Rollback mechanism:** the change is one extension file plus its test. `git revert` of the commit
  restores the session-sticky data-taint behavior with no other effect; flow-guard remains loadable.
