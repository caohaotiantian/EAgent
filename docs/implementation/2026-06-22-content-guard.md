# Implementation: content-guard

Design: `docs/design/2026-06-22-content-guard.md` (slug `2026-06-22-content-guard`).

## 1. Task Index

| Design Deliverable | Design AC | Phase task |
|---|---|---|
| `src/extensions/content-guard.ts` (§2) | AC3-AC9 | Phase 1, T6-T11 |
| `stripInvisible` helper (§2, D3) | AC1 (unit); AC5 (live, exercised through the filter) | Phase 1, T2/T6 |
| `fence` helper (§2, D4) | AC2, AC3 | Phase 1, T3/T7 |
| `afterToolCall` filter, foreign+success only (§2, D1/D2/D5) | AC3/AC4/AC5/AC6 | Phase 1, T4/T8/T9 |
| per-runtime counters + `/content-guard` cmd (§2, D6) | AC7/AC8 | Phase 1, T5/T10 |
| host.ts registration (§2) | AC10 | Phase 1, T11 |
| tests `test/content-guard.test.ts` (§2) | AC1-AC9 | Phase 1, T1-T5 (tests precede impl) |

## 2. Phase Breakdown

### Phase 1 — content-guard extension (single phase)

**Entry condition:** L1 design doc passed (it has). No prerequisite extensions.

**Design references:** `docs/design/2026-06-22-content-guard.md` §2 (Deliverables),
§4 D1-D6 (decisions), §7 (AC1-AC10).

**Task list (TDD order — every test task precedes the code it protects):**

- **T1 (test):** Create `test/content-guard.test.ts` importing the pure helpers
  `stripInvisible`, `fence` and the default `activate` from
  `../src/extensions/content-guard.js`, plus `makeHarness`, `coreTools`. (File
  scaffolding; subsequent test tasks add cases.)
- **T2 (test):** Unit — `stripInvisible` protects the invariant *"injection-vector
  invisible Unicode is removed but visible text (ASCII, accented Latin, CJK) is
  byte-identical"*: assert it removes U+200B, U+200D, U+FEFF, a bidi override
  (U+202E), a Plane-14 tag char (U+E0041), and a variation selector (U+FE0F), and
  returns a `stripped` count > 0; and assert `stripInvisible("café 日本語 x=1")`
  returns the input unchanged with `stripped === 0`.
- **T3 (test):** Unit — `fence` protects *"foreign content is wrapped with the
  provenance marker + standing note and the wrap is idempotent"*: assert
  `fence("hi","fetch")` starts with the standing note and contains
  `<untrusted-content source="fetch">` and `</untrusted-content>` around `hi`; and
  assert `fence(fence("hi","fetch"),"fetch") === fence("hi","fetch")`.
- **T4 (test):** Live — invariant *"a successful result from a net:fetch tool is
  fenced in the transcript"*: with a stub tool (registered by the test) named
  `grab` declaring `capabilities:["net:fetch"]` returning known content, run the
  agent so it calls `grab`; assert the resulting `tool_result` block's `content`
  begins with the `<untrusted-content` marker (AC3). In the same spirit add the
  negatives and the remaining live ACs: a stub tool declaring only `["fs:read"]`
  returning content is NOT fenced (AC4); a net:fetch body laden with one invisible
  codepoint per documented category is fenced with **no** invisible codepoint
  surviving in the model-visible `content` (AC5 — the live counterpart of T2's
  unit assertion, exercising `stripInvisible` through the filter, not directly);
  an `isError:true` net:fetch result is NOT fenced (AC6 half 1); and, with
  **both** content-guard and `recovery` loaded, a foreign `isError` result whose
  text matches a recovery rule carries recovery's hint **unwrapped** (no
  `<untrusted-content` marker) — pinning the D5 disjointness on the `isError`
  partition (AC6 half 2).
- **T5 (test):** Live — invariants for the kill switch and no-leak teardown:
  `EAGENT_CONTENT_GUARD=off` ⇒ a net:fetch result is unfenced (AC8); after
  `host.unload("content-guard")` a net:fetch result is unfenced (AC9); and after a
  fenced foreign result, the `/content-guard status` command output reports a
  non-zero **foreign-fenced** counter specifically (AC7 — assert on the
  foreign-fenced count by name, not just any non-zero number). Restore env in
  `finally`.
- **T6 (impl):** Implement and export `stripInvisible(text): { text: string; stripped: number }`
  — a single regex over the documented codepoint ranges (zero-width U+200B-U+200D
  & U+FEFF; bidi U+202A-U+202E & U+2066-U+2069; tag chars U+E0000-U+E007F;
  variation selectors U+FE00-U+FE0F), counting removals. Pure, no deps.
- **T7 (impl):** Implement and export `fence(content, source): string` with the
  marker/standing-note format from design D4 and the idempotency prefix check.
- **T8 (impl):** Implement the foreign decision: a helper `isForeign(call, cfg)`
  that reads `e.agent.tools.get(call.name)?.capabilities` and returns true iff any
  intersects `cfg.foreignCaps` (default `["net:fetch","mcp:call"]`, store key
  `foreignCaps`).
- **T9 (impl):** Implement `activate(e)`: register an `afterToolCall` filter that,
  when enabled and the result is **not** `isError` and `isForeign(ctx.call,cfg)`,
  applies `stripInvisible` then `fence(_, ctx.call.name)`, increments the
  per-runtime counters, and returns the transformed result; otherwise returns the
  result unchanged. Guard with `EAGENT_CONTENT_GUARD==="off"` (return a no-op
  disposer, mirroring recovery.ts) and a store `enabled` flag.
  - Sub-step: the three per-runtime counters are `foreignFenced`,
    `invisibleStripped` (from `stripInvisible`'s `stripped` total), and
    `markersFlagged` — the last is a **count-only flag** of override-phrase
    markers (`/ignore (all )?previous instructions/i`, `<|im_start|>`, `[INST]`)
    found in the foreign body; per design D3 the markers are counted, **never
    rewritten**.
- **T10 (impl):** Register the `/content-guard` command `[on|off|status]`
  (status prints the per-runtime counters), mirroring flow-guard's command shape.
- **T11 (impl):** Add `["content-guard", contentGuard]` to
  `src/host.ts` `BUILTIN_EXTENSIONS`, placed after `recovery` (import + array
  entry). Placement is convention/tidiness, **not** correctness — per design D5
  the two `afterToolCall` filters are disjoint on the `isError` partition, so any
  order is correct; adjacency to recovery is not a constraint.

**Per-task acceptance commands (runnable from repo root):**
- After T6/T7: `node --import tsx --test test/content-guard.test.ts` passes the
  unit cases (T2/T3).
- After T9/T10/T11: `node --import tsx --test test/content-guard.test.ts` passes
  all cases (T4/T5).
- Phase exit: `npm run typecheck` exits 0 AND `npm test` exits 0.

**Exit condition:** `test/content-guard.test.ts` green, `npm run typecheck` exit 0,
`npm test` exit 0 (full suite, no regression), content-guard registered in host.

## 3. Engineering Constraints Index

- **Engineering norms (`CLAUDE.md` House conventions):** ESM with `.js` import
  specifiers even for `.ts` files; strict TS (`noUncheckedIndexedAccess` etc., no
  `any`); zero runtime deps except jiti (pure Node string/regex only); every
  extension capability-gated where it has side effects (content-guard has none →
  no capability) and ships with offline tests; kill-switch env var.
- **Four-corner subagent template:** `references/loop-3-development.md`.
- **Commit conventions:** `feat(phase1): …` opener; `fix(phase1-roundR): <keyword>`
  within-round; `npm test` / `npm run typecheck` results as trailers; no mention of
  AI/model/tooling.

## 4. Data and Fixture Dependencies

- Reuse the existing offline harness `test/helpers.ts` (`makeHarness`,
  `MockProvider` scriptable responder, `lastText`). No new fixtures needed; the
  stub tools (`grab` net:fetch, an `fs:read` stub) are registered inline in the
  test via `e.registerTool`/`host.use` of a tiny inline extension, following the
  pattern in `test/recovery.test.ts` (core-tools + the extension under test).
- Invisible-Unicode test strings are constructed inline with `String.fromCodePoint`.

## 5. Regression Protection

- The full existing suite (`npm test`) must stay green — content-guard only adds
  an `afterToolCall` filter scoped to foreign+success results, so non-foreign
  flows are untouched. Specifically confirm `test/recovery.test.ts` still passes
  (recovery rides the same hook on error results; D5 disjointness must hold).
- `npm run typecheck` must stay clean (strict mode; the new file must not
  introduce `any` or unchecked index access).
