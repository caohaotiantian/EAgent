# web-paginate — `start_index` continuation for the web fetch tool

Status: closed
Closing-commit: c7bfcaa
Closed-on: 2026-06-22
Deferred: finding — direct fetch_url past-the-end tool-level test (cosmetic completeness nit; behavior covered transitively, no defect)
Date: 2026-06-22
Author: design author (EAgent)
Scope: a self-contained change to `src/extensions/web.ts` plus its test.

---

## 1. Background and Purpose

The `web` extension exposes a single `fetch_url` tool
(`src/extensions/web.ts:86-174`) that GETs/POSTs an http(s) URL and returns the
response body, capped in size. The cap is enforced by `readCapped`
(`web.ts:49-80`), which streams the response and stops once `maxBytes` bytes
have been consumed (default 1 MiB, `DEFAULT_MAX_BYTES`, `web.ts:24`). When the
body is longer than the cap, `readCapped` sets `truncated: true` (`web.ts:67`)
and the tool appends a **dead-end** marker — `TRUNCATION_MARKER` =
`"\n…[truncated]"` (`web.ts:27`, applied at `web.ts:166`).

The problem: that marker is a dead end. `readCapped` always reads from the
**start** of the stream, so the tail of a long article, log, or API page beyond
the first `maxBytes` is **permanently unreachable** — the model is told the body
was truncated but given no way to read the rest. Raising `maxBytes` only moves
the wall and risks blowing the context window / per-output byte caps that
`limits` and `prune` exist to enforce.

The MCP reference fetch server solves exactly this with a `start_index`
continuation: the model reads a long page one window at a time, re-issuing the
fetch with an advancing offset. **Purpose of this extension:** add that same
`start_index` continuation to `fetch_url` so the model can page past the byte
cap — read a long page a window at a time — with a minimal, backward-compatible
change to `web.ts`.

The fix is two small edits to `readCapped` and the tool body, plus one new
optional parameter:

- `readCapped` gains a `startIndex` argument: it **skips** the first
  `startIndex` bytes of the stream (streaming-and-discarding, never buffering),
  then collects up to `maxBytes` from there — that slice is the *window*.
- When the result is truncated (more bytes remained after the window), the tool
  returns an **actionable** hint —
  `more content available — continue with start_index=<N>` where
  `N = startIndex + bytesShown` — **instead of** the dead-end
  `TRUNCATION_MARKER`, so the model can re-issue the fetch for the next window.

---

## 2. Deliverables

- [x] `src/extensions/web.ts` — `readCapped` gains a `startIndex` parameter that
      stream-skips the first `startIndex` bytes before collecting up to
      `maxBytes`; the `fetch_url` `parameters` schema gains an optional
      `start_index` (integer, default 0); the truncated branch emits the
      `continue with start_index=N` hint in place of `TRUNCATION_MARKER`.
- [x] `readCapped` and the continuation-hint builder (`continuationHint`)
      exported as **named** exports from `web.ts` so the test can unit-test the
      byte-window logic directly (over an in-memory `ReadableStream`, no
      network), mirroring how `recovery.ts` exports `recoveryHint`/`annotate`.
- [x] `test/web-paginate.test.ts` — offline `node:test` suite **(consolidated
      into `test/web.test.ts`** per the impl-doc BATCH MODE deviation; reuses the
      in-file `node:http` fixture server**): unit tests of `readCapped` with
      `startIndex` over an in-memory `ReadableStream`, a schema assertion that
      `fetch_url` advertises `start_index`, an end-to-end paging test through the
      agent loop against the `node:http` fixture, and a kill-switch test.
- [x] Kill switch: `EAGENT_WEB_PAGINATE=off` reverts `fetch_url` to today's
      behavior (ignore `start_index`, emit `TRUNCATION_MARKER` on truncation).
- [x] host.ts registration — **(deferred to batch integration)**. `web` is
      already in `BUILTIN_EXTENSIONS`; this change is internal to `web.ts` and
      adds **no new extension id**, so there is nothing for the batch step to
      register. Noted for completeness only.
- [x] Command — **none.** This change extends the existing `fetch_url` tool and
      the existing `/fetch` command (`web.ts:176-209`); no new command is added
      (see Scope Boundary). The `/fetch` call site (`readCapped(res.body,
      DEFAULT_MAX_BYTES)`) is unchanged — `startIndex` defaults to 0.
- [ ] CLAUDE.md / README inventory line — **(deferred to batch integration)**.
      The `web` bullet in CLAUDE.md gets a clause noting `start_index`
      continuation; the README extension **count does not change** (no new
      extension). Reconciled at closeout by the batch step.
- [x] `docs/implementation/2026-06-22-web-paginate.md` — closeout notes
      (deliverable ticks, `npm test` + `npm run typecheck` results).

---

## 3. Scope Boundary (NON-goals — Simplicity First)

This is the **minimum** change that makes the tail of a capped page reachable.
Explicitly **out of scope**:

- **No new tool and no new command.** `start_index` is an optional argument on
  the existing `fetch_url`; `/fetch` is untouched. A second "paginate" tool
  would duplicate `fetch_url`'s validation, capability gate, and reader for no
  gain (decision D1).
- **No content/HTML extraction, markdownification, or boundary-aware
  windowing.** The window is a raw byte slice, exactly as today's cap is. We do
  not try to split on element/line/sentence boundaries.
- **No cross-fetch state, caching, ETag/Range, or server-side `Range:`
  headers.** Each fetch is independent and re-downloads from offset 0 over the
  socket, discarding the skipped prefix. We do not add an HTTP `Range` request
  (the upstream may not honor it; correctness must not depend on it).
- **No char-offset or grapheme-offset addressing.** Offsets are **bytes**, to
  match `maxBytes` semantics (decision D4).
- **No automatic multi-window assembly.** The tool returns one window plus a
  hint; the *model* decides whether to continue. We do not loop internally.
- **No change to the capability model.** `fetch_url` stays gated on `net:fetch`
  (`web.ts:92`); `start_index` adds no side effect and therefore no new
  capability.
- **No change to `limits`/`prune`.** Those still cap/spill the *returned* window;
  this change is orthogonal (see Relationship).

---

## 4. Key Design Decisions

### D1 — Extend `fetch_url` vs. add a new pagination tool

**Problem.** The continuation needs an offset input and a continuation-hint
output. Where does that live?

**Options.**
(a) Add an optional `start_index` argument to the existing `fetch_url`.
(b) Add a separate tool (e.g. `fetch_page` / `paginate_url`) dedicated to
windowed reads.

**Choice: (a) extend `fetch_url`.**

**Rationale.** The change is genuinely small: one optional parameter and one
output branch, both inside the existing tool. `start_index` defaults to `0`, so
**every existing call is byte-for-byte unchanged** (backward compatible). The
tool already owns URL validation (`validateUrl`, `web.ts:36-42`), the `net:fetch`
gate (`web.ts:92`), and `readCapped` — paging reuses all of it.

**Why (b) rejected.** A second tool would duplicate `validateUrl`, the
capability declaration, the fetch/redirect handling, and `readCapped` — and
present the model with two near-identical tools to choose between, the kind of
surface bloat CLAUDE.md's "new behavior is an extension, never a fork" plus
Simplicity-First explicitly push against. It buys nothing: the offset is one
integer that slots cleanly into the existing schema.

### D2 — Skip bytes by stream-and-discard vs. buffer-then-slice

**Problem.** To start the window at byte `start_index`, the reader must skip the
first `start_index` bytes of the response.

**Options.**
(a) Keep streaming `readCapped`; consume and **discard** chunks until
`start_index` bytes have passed, then begin collecting the window (still capped
at `maxBytes`).
(b) Buffer the whole response, then `slice(start_index, start_index + maxBytes)`.

**Choice: (a) stream-and-discard.**

**Rationale.** `readCapped` exists precisely so "a huge or hostile response
never fully lands in memory" (`web.ts:45-47`). Skipping by reading-and-dropping
chunks preserves that bounded-memory guarantee exactly: at any moment we hold at
most one chunk plus the (≤ `maxBytes`) window. Memory stays O(maxBytes)
regardless of how large `start_index` or the body is.

**Why (b) rejected.** Buffering the entire body to slice it throws away the only
reason `readCapped` streams. A multi-GB or adversarial response at a large
`start_index` would have to be fully materialized — reintroducing the unbounded
memory blow-up the current code was written to prevent. Unacceptable for a
network egress tool.

*Discard-boundary detail (in scope of this decision):* a chunk may straddle the
`start_index` boundary. The skip logic drops only the prefix of that chunk and
feeds the remainder into the window collector, so the window starts exactly at
byte `start_index`. Decoding is per-window (`new TextDecoder()` over the window
bytes only); a UTF-8 sequence split across the window's leading or trailing byte
boundary is rendered as the standard replacement character, the same lossy
edge the current single-window code already has at `maxBytes`.

### D3 — Continuation hint vs. dead-end `TRUNCATION_MARKER`

**Problem.** When the window is truncated (bytes remain after it), what does the
tool tell the model?

**Options.**
(a) Append a continuation hint: `more content available — continue with
start_index=<N>` where `N = start_index + bytesShown`.
(b) Keep the existing `TRUNCATION_MARKER` (`"\n…[truncated]"`, `web.ts:27`).

**Choice: (a) the actionable hint, replacing the marker on truncation.**

**Rationale.** The whole point of the feature is to make the tail reachable; a
marker that merely says "truncated" gives the model nothing to act on, whereas a
hint carrying the **exact next offset** is a ready-made next call. `N` is
computed from what was actually shown (`start_index + bytesShown`), so chained
calls walk the body without gaps or overlap. This directly parallels the project
pattern of turning a dead-end into an actionable nudge — `recovery` rewrites
failed results into corrective hints, and `limits` replaces a bare clip with a
retrieval hint (`limits.ts:175-181`).

**Why (b) rejected.** `TRUNCATION_MARKER` is the dead-end this design exists to
remove; keeping it would ship the offset machinery while still hiding it from
the model. (The marker is **retained only** under the kill switch — see Risks —
so `EAGENT_WEB_PAGINATE=off` restores today's exact output.)

### D4 — Byte offset vs. character offset

**Problem.** In what unit is `start_index` expressed?

**Options.** (a) Bytes. (b) Characters (code points / UTF-16 units).

**Choice: (a) bytes.** *(This is the unit that makes the offset arithmetic
exact; included as a behavioral decision because it changes what `N` means and
how windows chain.)*

**Rationale.** The cap that creates truncation is already a **byte** cap
(`maxBytes`, counted as `value.byteLength`, `web.ts:63,70`). The continuation
offset must be in the same unit as the cap, or `N = start_index + bytesShown`
would not line up with where the previous window's bytes actually ended. Bytes
make the arithmetic exact and the skip cheap (count consumed bytes; no decoding
needed to locate the boundary).

**Why (b) rejected.** A character offset would force decoding the skipped prefix
just to count characters (defeating the cheap byte-skip), and would not align
with `maxBytes`, so windows could overlap or gap at multi-byte characters.
Worse, "character" is itself ambiguous (code point vs. UTF-16 unit vs.
grapheme). Bytes are unambiguous and already the tool's native unit.

---

## 5. Dependencies and Assumptions

- **Files touched:** only `src/extensions/web.ts` and a new
  `test/web-paginate.test.ts` (plus docs). No kernel change.
- **No new runtime dependencies.** Pure Node: `fetch`, `ReadableStream`,
  `TextDecoder` — all already used by `web.ts`. Honors "zero runtime deps except
  `jiti`."
- **Schema is what the model sees** (`define.ts:6, 33`): the `start_index`
  description must state it is a **byte** offset and defaults to 0.
- **`ctx.signal`** (`types.ts:156`) keeps aborting the fetch as today; skipping
  bytes is part of the same streamed read, so abort still works mid-skip.
- **Assumption (best-effort, documented):** the page is reasonably stable
  between windowed fetches. Each fetch is independent and re-downloads from
  offset 0, discarding the prefix; a page that changes between calls can yield a
  seam. Accepted and documented (see Risks) — matches the MCP fetch server's own
  contract.
- **Assumption:** `start_index >= body length` is legal input → the window is
  empty and the result is **not** truncated, so **no** continuation hint is
  emitted (handled gracefully, see Acceptance). Negative/NaN `start_index` is
  clamped to 0 via `Math.max(0, Number(...))`, mirroring the existing `maxBytes`
  guard (`web.ts:125`).

---

## 6. Relationship with Existing Designs

**Closest code — modified directly:**

- `src/extensions/web.ts` — the `fetch_url` tool (`:86-174`), `readCapped`
  (`:49-80`), `TRUNCATION_MARKER` (`:27`), the `parameters` schema (`:93-115`),
  and the `maxBytes` clamp pattern (`:125`). This design adds `start_index` to
  the schema, threads a `startIndex` skip through `readCapped`, and swaps the
  marker for a hint on truncation. **No conflict** — it is a superset of today's
  behavior, gated identically on `net:fetch` (`:92`).

**Adjacent but distinct (the dedup check):**

- `src/extensions/limits.ts` — caps a single tool output to
  `maxToolOutputBytes` *after the fact* and, on overflow, **spills** the full
  output to disk with a retrieval hint (`limits.ts:151-190`). That bounds what
  lands in the context window; it does **not** let the model read *past the web
  fetch's own byte cap*. Distinct, and the two compose: `limits` may spill the
  returned window; `web-paginate` lets the model request the *next* window.
- `src/extensions/prune.ts` — truncates old, oversized `tool_result` content on
  `transformContext` to reclaim tokens (`prune.ts:50-82`). Also post-hoc, also
  about context size, also unable to recover bytes the upstream fetch never read.
  Distinct.
- `docs/design/2026-06-22-circuit-breaker.md` (in-flight sibling, same date) —
  trips on a `beforeToolCall` loop of *identical* calls, keyed on **name+args**
  (D2; `circuit-breaker.md:426-427`), and explicitly reasons about "the
  advancing pagination case" (`:426`) and "a paginated read whose page token is
  *not* in the args" (`:461`). **Benign, and mutually consistent by
  construction:** every continuation hint advances `start_index`
  (`N = start_index + bytesShown`, §4 `:178`; `bytesShown > 0` whenever a hint
  is emitted), so each paged `fetch_url` carries a *distinct* `start_index`
  argument and therefore a distinct signature — exactly the case the breaker
  states it never trips (`circuit-breaker.md:468-470`, AC-8). The page token
  lives in the args, not out of band, so legitimate multi-window paging is **not**
  blocked. No coordination required.

**Net:** `prune`/`limits` cap or spill output bytes the tool already produced;
**nothing in the repo lets the model resume a web fetch past its byte cap.** No
existing extension or shortlist item *implements* web-fetch pagination
(`circuit-breaker` reasons about the advancing-args pattern but only to confirm
it never trips, see above). This is the first design to add the capability; it
modifies `web.ts` rather than adding an extension.

**Pattern reuse (not conflict):** exporting pure helpers for direct unit testing
follows `recovery.ts` (`recoveryHint`/`annotate`); turning a dead-end into an
actionable hint follows `recovery` and `limits` (`limits.ts:175-181`); the
`EAGENT_*=off` kill switch follows `prune` (`EAGENT_PRUNE`, `prune.ts:51`),
`recovery`, `microagents`, and `write-guard`.

---

## 7. Acceptance Criteria

All tests are offline `node:test` via `tsx`, loaded with `host.use("web", web)`
(no dependency on `BUILTIN_EXTENSIONS`). The byte-window logic is unit-tested
against an in-memory `ReadableStream` (e.g. `ReadableStream.from([...])` over
`Uint8Array` chunks) so **no network** is involved; the end-to-end paging test
reuses the existing `node:http` fixture-server pattern from `test/web.test.ts`.

1. **Schema advertises `start_index`.** Asserting on the `fetch_url` tool spec:
   `tool.spec.parameters.properties.start_index` exists, is `type: "integer"`,
   has `default: 0`, and its description names **bytes**. (Runnable equality /
   `assert.ok` on the spec object.)

2. **`readCapped(stream, maxBytes, 0)` is unchanged.** With `startIndex = 0`
   over a known multi-chunk stream, `text`/`bytes`/`truncated` equal today's
   values exactly. (Assert `bytes === maxBytes`, `truncated === true` on an
   over-cap body; full text on an under-cap body.)

3. **`readCapped` skips `startIndex` bytes.** For a 30-byte in-memory stream of
   known content, `readCapped(stream, 10, 10)` returns `text` equal to bytes
   `[10,20)` of the source and `truncated === true` (10 bytes remain after the
   window). (`assert.equal` on the exact decoded substring.)

4. **Boundary-straddling skip is exact.** With chunk sizes chosen so a chunk
   crosses the `startIndex` boundary (e.g. chunks of 7 bytes, `startIndex = 10`),
   the window still starts at exactly byte `start_index`. (`assert.equal` on the
   decoded window vs. the source slice.)

5. **Continuation hint carries the right `N`.** When `readCapped` reports
   `truncated`, the tool's returned content contains
   `start_index=<startIndex + bytesShown>` and does **not** contain
   `…[truncated]`. (`assert.match` for the computed integer; `assert.ok(!/…\[truncated\]/...)`.)

6. **End-to-end paging reaches the tail.** Through the agent loop against the
   `node:http` fixture (a body of N known bytes, `maxBytes` < N): the first
   `fetch_url` result contains a `start_index=` hint; a second `fetch_url` with
   that offset returns the **tail** bytes and (when the tail fits) contains
   **no** continuation hint. (Two `agent.run` turns; `assert.match` on each
   tool-result, asserting the concatenation covers the whole body with no gap.)

7. **Past-the-end is graceful.** `fetch_url` with `start_index` ≥ body length
   returns an **empty window**, `isError === false`, and **no** continuation
   hint (nothing left to continue to). (`assert.equal`/`assert.ok(!/start_index=/...)`.)

8. **Negative/NaN `start_index` clamps to 0.** `start_index: -5` (and a
   non-numeric value) behaves identically to `start_index: 0`. (Assert the
   returned window equals the `start_index: 0` window.)

9. **Kill switch restores legacy output.** With `EAGENT_WEB_PAGINATE=off`, a
   truncated fetch emits `…[truncated]` (the `TRUNCATION_MARKER`) and **no**
   `start_index=` hint, and a `start_index` argument is ignored (window starts
   at byte 0). (`assert.match(/…\[truncated\]/)` + absence of the hint.)

10. **Clean teardown.** `await host.dispose()` after loading `web` does not throw
    (the existing `web` activate registers a tool + command; this change adds no
    new registration). (Test completes without rejection.)

11. **Suite is green offline:** `npm test` and `npm run typecheck` both pass with
    no network and no `ANTHROPIC_API_KEY`.

---

## 8. Risks and Rollback

**Kill switch.** `EAGENT_WEB_PAGINATE=off` (read inside the tool body, the same
shape as `EAGENT_PRUNE`/`EAGENT_RECOVERY`) makes `fetch_url` ignore `start_index`
and re-emit the legacy `TRUNCATION_MARKER` on truncation — byte-for-byte today's
behavior. This is the instant escape hatch if the hint confuses a model or a
downstream parser keys on `…[truncated]`.

**Risks and mitigations.**

- **Non-deterministic page changes between windows.** If the upstream body
  changes between fetch #1 and fetch #2, the offset can land mid-token and
  windows may not cleanly concatenate. *Mitigation:* documented best-effort
  contract; each fetch is independent (no cross-call state to corrupt); this is
  the same limitation the MCP fetch server documents. No correctness invariant
  in EAgent depends on cross-fetch stability.
- **`start_index` past the end.** Returns an empty window with no continuation
  hint and `isError: false` (Acceptance #7) — a benign no-op, not an error or a
  crash.
- **Multi-byte character split at a window boundary.** A UTF-8 sequence split at
  the window's leading/trailing byte boundary renders as the replacement
  character — the **same** lossy edge today's single-window `maxBytes` cap
  already has (`web.ts:64-66`); the change does not make it worse.
- **Model over-paging a huge body.** Each window is still capped at `maxBytes`,
  and `limits`' per-run tool-call budget (`limits.ts:210-228`) bounds how many
  continuation calls a run may make. No new unbounded loop is introduced (the
  tool never loops internally — D-scope, decision in §3).
- **Memory.** Preserved by D2: stream-and-discard keeps memory at O(maxBytes)
  regardless of `start_index`. No regression versus today.

**Rollback.** The change is backward-compatible by construction (`start_index`
defaults to 0 ⇒ identical to today). Two levers, cheapest first: (1) set
`EAGENT_WEB_PAGINATE=off` to neutralize it with no redeploy; (2) revert the
`web.ts` diff and delete `test/web-paginate.test.ts` — no kernel, host, or other
extension is touched, so the revert is local and clean. Because no new extension
id is added, no `BUILTIN_EXTENSIONS` or README count change needs unwinding.
