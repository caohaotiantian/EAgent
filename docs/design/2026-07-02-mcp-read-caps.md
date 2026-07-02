Status: closed
Closing-commit: b13ace3
Closed-on: 2026-07-02
Deferred: none

# Design — cap MCP transport reads (SRV-4b / item ③)

**Slug:** `2026-07-02-mcp-read-caps` · **Tier:** Full (>3 files: a shared-helper relocation + both MCP
transports + tests; an env-cap threshold decision; a cross-cutting move). Source: `docs/HANDOFF.md` §4
item ③ / `docs/DEFERRED-FOLLOWUPS.md` SRV-4b. Branch: `chore/finish-open-items`.

## 1. Background and Purpose

MCP servers are foreign code EAgent talks to "at arm's length" (`mcp.ts:1-26`). Two of those read paths
buffer an entire server-controlled payload into memory with **no size cap** — a hostile or broken MCP
server can OOM the host:

- **HTTP transport** (`HttpTransport.#readResponse`, `mcp.ts:347-359`): `await res.text()` on an SSE
  reply (`mcp.ts:354`) and `await res.json()` on a JSON reply (`mcp.ts:358`) each read the whole body.
- **stdio transport** (`StdioTransport`, `mcp.ts:189-190`): `createInterface({ input: child.stdout })`
  with default options — Node readline buffers a single line **unboundedly** until a newline arrives, so
  a server emitting a huge no-newline run on stdout grows memory without bound (the stdio analog of the
  parseSSE OOM).

SRV-4 (`docs/design/2026-07-02-sse-buffer-cap.md`) capped the shared `parseSSE` for the three fetch
*providers* and explicitly deferred these MCP reads as **SRV-4b** (that doc, §non-goals + closure:
*"the MCP transport reads … need a `readCapped` relocation / custom readline byte-counting, a distinct
change"*). The byte-window primitive `readCapped` already exists but lives inside `web.ts`
(`web.ts:62`), not in a shared location MCP can import.

**If we do not fix it:** a single foreign MCP server (HTTP or stdio) can exhaust host memory — a DoS on
the shared server host — despite the provider-side SSE cap already shipped.

## 2. Deliverables

- [x] `readCapped` is **relocated** from `web.ts` into `src/extensions/lib/read-capped.ts` (a shared
  helper, matching the `lib/` convention); `web.ts` imports it from `./lib/read-capped.js` with its two
  call sites (`web.ts:218,272`) unchanged in behavior.
- [x] A new env-overridable cap helper `maxMcpReadBytes()` (env `EAGENT_MAX_MCP_READ_BYTES`, default
  **16 MiB**, `Number.isInteger(n) && n > 0` else default) co-located in `mcp.ts`, modeled exactly on
  `providers/http.ts:16-21`'s `maxSseEventBytes()`.
- [x] `HttpTransport.#readResponse` reads `res.body` via `readCapped(res.body, maxMcpReadBytes())` for
  both the SSE and JSON branches; on `truncated`, it throws a clear "response exceeded N bytes" error
  (surfaced through the existing transport error path). A null `res.body` falls back to `res.text()` /
  `res.json()` (mirroring `web.ts:272`).
- [x] `StdioTransport` replaces the default `createInterface` with a **byte-bounded line reader**: it
  reads `child.stdout` directly, emits complete newline-delimited lines to the existing `#onLine`, and
  when the current un-terminated line buffer exceeds `maxMcpReadBytes()` it enters "discard until the
  next newline" mode (dropping the oversized line, then resuming) — so a no-newline flood cannot grow
  memory beyond the cap. The line-framing logic is factored as an **exported, pure step** over
  `(bufferState, chunk, cap)` that returns the emitted complete lines, the retained buffered-byte count,
  and whether it is in discard mode — a testable observable so a unit test can assert the retained buffer
  never exceeds the cap (a real boundedness discriminator, not just "the valid line survives").
- [x] `docs/HANDOFF.md:142`'s "the SRV-4b MCP caps … un-offline-testable by design" is corrected at
  closeout to scope that claim to a *live hostile-server smoke* (the cap logic is offline-tested here).
- [x] Tests: HTTP SSE + JSON over-cap → error (small env cap); a stdio bounded-reader unit test that
  feeds a ≫cap no-newline run and asserts the retained buffer stays ≤ cap and discard mode engages, then
  a following valid line still parses; relocated `readCapped` unit tests pass from the new path; existing
  MCP + web suites green.

## 3. Scope Boundary (NOT in scope)

- **Not** changing `web.ts`'s `fetch_url` tool or `/fetch` command behavior — the `readCapped` move is a
  pure relocation (identical function body, identical call sites). `DEFAULT_MAX_BYTES`, `TRUNCATION_MARKER`,
  and `continuationHint` **stay in `web.ts`** (web-pagination-specific; no MCP consumer).
- **Not** changing the MCP JSON-RPC framing, the methods called, the handshake, `parseResourceList`,
  the `MAX_RESOURCES` catalog cap, or the tool-poisoning scan.
- **Not** adding MCP-side pagination / continuation (MCP reads one correlated response; unlike a fetched
  web page there is nothing to page).
- **Not** changing `HTTP_REQUEST_TIMEOUT_MS` or the abort/timeout plumbing, **and not adding a new
  stdio per-request timeout** (the stdio silent-drop residual in §8 is bounded by the existing
  abort / child-exit paths; a dedicated stdio timeout is a separate concern).
- **Not** touching `src/kernel/`.
- **Not** re-capping the provider `parseSSE` (SRV-4, already shipped) — this is a *different* SSE parser
  (`HttpTransport.#parseSse`, `mcp.ts:362`, over an already-buffered string).

## 4. Key Design Decisions

### D1 — Relocate `readCapped` to `src/extensions/lib/` (vs. import across extensions)
**Problem:** MCP needs the byte-window read that currently lives in `web.ts`.
**Options:** (a) move `readCapped` into `lib/read-capped.ts`, both `web` and `mcp` import it; (b) leave
it in `web.ts` and have `mcp.ts` import from `../web.js`; (c) duplicate the function.
**Choice:** (a). `src/extensions/lib/` is the established home for cross-extension helpers (`decode`,
`edit-match`, `otel-context`, `relevance`, `sandbox`); `edit-match` was itself recently moved there for
exactly this reason. **Rejected:** (b) an extension→extension import couples two peers and is load-order
fragile — `lib/` exists precisely to avoid it; (c) violates DRY and would let the two copies drift.

### D2 — Move only `readCapped` (vs. move the whole web read-block)
**Problem:** decide the relocation boundary.
**Choice:** move **only** `readCapped` (the shared byte-window primitive). `DEFAULT_MAX_BYTES`,
`TRUNCATION_MARKER`, and `continuationHint` are web-pagination concepts with no MCP consumer and stay in
`web.ts`. **Rejected:** moving them all pollutes `lib/` with web-only concepts and needlessly churns
`web.ts` — a Surgical-Changes violation.

### D3 — MCP cap value: a new env-overridable `maxMcpReadBytes()`, default 16 MiB
**Problem:** what bound, and is it operator-tunable?
**Options:** (a) reuse `web.ts`'s `DEFAULT_MAX_BYTES` (1 MiB); (b) a new `maxMcpReadBytes()` env helper
(`EAGENT_MAX_MCP_READ_BYTES`, default 16 MiB) mirroring `maxSseEventBytes()`; (c) a bare hardcoded const.
**Choice:** (b). It is consistent with the SRV-4 sibling precedent (`providers/http.ts:16-21`): an
env-overridable OOM-safety bound, generous power-of-two default, `Number.isInteger(n) && n > 0`
validation falling back to the default. **Rejected:** (a) 1 MiB is a *web-page-fetch* default (and there
it is a caller-raisable tool arg); a legitimate MCP tool result can exceed it, and MCP exposes no
per-call size arg, so 1 MiB would wrongly truncate honest payloads. (c) a hardcoded const is
inconsistent with SRV-4's operator-tunable posture and gives no escape hatch.

### D4 — On an over-cap HTTP read: throw explicitly (vs. parse the truncated slice)
**Problem:** `readCapped` returns a possibly-truncated `text`; a truncated JSON/SSE body is unparseable.
**Choice:** when `truncated` is true, **throw** `MCP HTTP response … exceeded N bytes` (caught by the
existing `try/catch` in the tool `execute`, `mcp.ts:532-534`, → a clean `fail(...)`). This mirrors
SRV-4's throw-on-overflow and gives a precise error instead of a cryptic `JSON.parse`/`#parseSse` failure
on a mangled slice. Single-option (throwing is the only correct handling of an un-parseable truncation) —
called out per the review template.

### D5 — stdio cap: a byte-bounded custom line reader with discard-to-newline overflow
**Problem:** Node's `createInterface` buffers an un-terminated line unboundedly; there is no option to
bound it, and checking `line.length` in `#onLine` is too late (the OOM already happened).
**Options:** (a) read `child.stdout` directly with a byte-counting buffer that emits complete lines and,
on exceeding the cap before a newline, discards until the next newline then resumes; (b) check length in
`#onLine` (after-the-fact — useless); (c) a `createInterface` line-length option (none exists).
**Choice:** (a). It is the only mechanism that actually bounds memory. Discard-to-newline (rather than
truncate-and-emit) is chosen so a dropped oversized line cannot corrupt the *following* valid line — the
reader resyncs cleanly on the next newline. The reader is a small exported helper unit-tested over
in-memory chunks. **Rejected:** (b) does not prevent the OOM; (c) does not exist.

### D6 — Cap **both** transports (vs. HTTP-only, deferring stdio)
**Problem:** the stdio cap (D5) is more code than the HTTP cap (D1 reuse); is it in scope?
**Options:** (a) cap both HTTP and stdio now; (b) cap HTTP now, defer stdio as a further follow-up.
**Choice:** (a). SRV-4b's tracked scope names *both* reads (`mcp.ts:354` **and** `mcp.ts:189`, "custom
readline byte-counting"), and MCP's own design treats a spawned stdio server as foreign, untrusted code
(`mcp.ts:1-26`) — the same threat model as the HTTP URL. Splitting would leave the tracked item half-done.
**Rejected:** (b) leaves a named OOM vector open and would need its own SRV-4c row; the stdio reader is
contained (~20 lines in `StdioTransport`) and independently unit-tested, so the added surface is small
and justified.

## 5. Dependencies and Assumptions

- **Stdlib only** (`ReadableStream`/`TextDecoder` for `readCapped`; `child.stdout` `Readable` events for
  the stdio reader). Zero new dependency.
- **Assumption (verified):** a fetch `Response` from the HTTP transport exposes `.body` as a
  `ReadableStream` — `HttpTransport.notify` already uses `res.body?.cancel()` (`mcp.ts:307`).
- **Assumption (verified):** `readCapped` is a pure function over a `ReadableStream` with in-memory-stream
  unit tests (`test/web.test.ts:11-20` `streamOf`/`bytesOf`), so relocation only changes the import path.
- **Assumption (verified):** MCP is opt-in via `EAGENT_MCP_SERVERS` (`mcp.ts:476`; absent ⇒ no transports),
  so this change is inert unless MCP is configured.
- **Assumption:** 16 MiB is far above any legitimate single MCP response/line (consistent with SRV-4's
  16 MiB rationale).

## 6. Relationship with Existing Designs

- `docs/design/2026-07-02-sse-buffer-cap.md` (SRV-4) — the direct precedent and parent. It caps the
  *provider* `parseSSE` and names this task as SRV-4b. This design mirrors its helper shape
  (`maxSseEventBytes()` → `maxMcpReadBytes()`), env-var style, default (16 MiB), and throw-on-overflow.
  **No conflict** — a distinct code path (MCP transports vs provider stream).
- `docs/design/2026-06-22-web-paginate.md` — the **governing design that owns `readCapped`** (it
  introduced the `startIndex` byte offset, the `truncated` byte-window semantics, and `continuationHint`).
  This design **relocates** that function verbatim to `lib/read-capped.ts` and preserves its
  `start_index` / byte-window continuation contract unchanged (the web call sites and their pagination
  behavior are untouched; AC5 guards it). No conflict — a pure move of the primitive it defined.
- `docs/design/2026-06-22-mcp-resources.md` — governs the resources half; its catalog/enumeration design
  is untouched, and the `MAX_RESOURCES` catalog cap is a separate already-present bound (`mcp.ts:91`).
  Note: because the new cap sits in the shared transport read paths (`#readResponse` and the stdio line
  reader), live `resources/read` bodies (`mcp.ts:572`) gain the same OOM bound — a uniform benefit across
  all transport reads, not a change to the resources design. No conflict.
- `README.md` `web` / `mcp` rows — `readCapped` is an internal helper, not a documented surface; the
  relocation needs no README change. (Verified: README describes tools/commands, not helper locations.)
- **⚠️ Conflict — `docs/HANDOFF.md:142`** lists "the SRV-4b MCP caps" among "Live-endpoint smokes …
  un-offline-testable by design." That is imprecise: the **cap-enforcement logic** *is* offline-testable
  (SRV-4 proved it for `parseSSE`; AC2/AC3 use the existing in-process `test/mcp-http.test.ts` loopback
  fixture, AC4 an in-memory chunk unit test) — only a *live smoke against a real hostile server* is not.
  This design supersedes that characterization for the cap logic. `HANDOFF.md:142` is flagged for
  correction at closeout (narrow the "un-offline-testable" claim to the live smoke, not the cap logic).

## 7. Acceptance Criteria (measurable, automatable)

- **AC1** `node --import tsx --test test/mcp.test.ts test/mcp-http.test.ts test/web.test.ts
  test/read-capped.test.ts` exits 0.
- **AC2 (HTTP SSE cap)** Extending the in-process HTTP fixture (`test/mcp-http.test.ts:41-101`) with a
  `text/event-stream` reply padded **larger than** a test-set `EAGENT_MAX_MCP_READ_BYTES` (restored in
  `finally`). Because the HTTP handshake reads (`initialize`/`tools/list`) traverse the **same**
  `#readResponse` cap path, the test cap MUST be set **above** the normal handshake/reply sizes with the
  oversized body padded well **above** the cap (e.g. cap ≈ 2 KiB, oversized ≥ 8 KiB): the oversized MCP
  tool call resolves to an `isError` result whose text contains "exceeded", while the handshake and a
  within-cap SSE reply resolve normally.
- **AC3 (HTTP JSON cap)** Same fixture, an `application/json` body padded above the cap → the call errors
  with "exceeded"; the handshake and a normal (within-cap) JSON body (the existing tests) still succeed.
- **AC4 (stdio cap — with a boundedness discriminator)** A unit test of the exported pure line-step over
  an in-memory chunk sequence asserts, as the load-bearing discriminator, that the **retained
  buffered-byte count never exceeds `cap`** while a single no-newline run **much larger than `cap`** is
  fed chunk-by-chunk (this fails a "buffer everything, then discard at the newline" implementation that
  still OOMs — the clause "the valid line survives" alone does not). It further asserts the step reports
  **discard mode engaged** before any newline, then that after the next `\n` a following valid JSON line
  is emitted intact (resync). Plus a fixture integration check that a valid response still resolves after
  the server emits an oversized line.
- **AC5 (relocation is behavior-preserving)** The `readCapped` unit tests move to
  `test/read-capped.test.ts` importing `../src/extensions/lib/read-capped.js` and pass unchanged; the
  full `test/web.test.ts` (fetch_url / `/fetch` / pagination) stays green — proving the move changed no
  behavior.
- **AC6** `npm test` exits 0 (full suite); `npm run typecheck` exits 0; `npm run eval` exits 0 (5/5);
  `src/kernel/` byte-identical; no new `package.json` dependency.

**Quality budget:** MCP reads are an I/O surface; the declared budget is "no server-controlled payload
can grow host memory beyond `maxMcpReadBytes()`", realized as AC2/AC3 (HTTP) + AC4 (stdio). A latency /
throughput budget is intentionally **excluded** — the cap is an OOM-safety bound, not a throughput lever
(within-cap reads stream identically to today).

## 8. Risks and Rollback

- **Risk — the relocation subtly changes `readCapped` behavior.** *Mitigation:* pure move (identical
  body); *guard:* AC5 (moved unit tests + full web suite green).
- **Risk — a legitimate large MCP response is wrongly truncated.** *Mitigation:* 16 MiB default is far
  above any real single response, and `EAGENT_MAX_MCP_READ_BYTES` lets an operator raise it. *Residual:*
  a >16 MiB honest response now errors instead of loading — acceptable (and configurable); documented.
- **Risk — the custom stdio reader mis-frames lines** (drops/merges valid lines, breaking MCP). *Mitigation:*
  discard-to-newline resync + the exported reader's dedicated unit test (AC4) plus the existing
  `test/mcp.test.ts` stdio round-trip suite (green = framing preserved).
- **Risk — `res.body` is null on some runtime** → *Mitigation:* the `res.text()`/`res.json()` fallback
  (mirrors `web.ts:272`), so behavior degrades to today's (uncapped) read only when no stream exists.
- **Risk — over-cap handling is asymmetric between transports.** HTTP throws immediately on `truncated`
  → a clean `fail(...)` (D4). stdio instead *silently drops* the oversized line (discard-to-newline, D5);
  because `StdioTransport` has **no** per-request timeout (unlike HTTP's `HTTP_REQUEST_TIMEOUT_MS`,
  `mcp.ts:146,330`), the correlated JSON-RPC request stays in `#pending` (`mcp.ts:198-216`) until the
  turn's `signal` aborts it (`onAbort`, `mcp.ts:199-201`) or the child exits/disposes (`#failAll`,
  `mcp.ts:185,258`). *Assessment:* acceptable — a dropped hostile line hanging one request is strictly
  better than an OOM, and the existing abort / child-exit paths are the mitigation (a pending request is
  never orphaned beyond the turn). Named here as a known, bounded behavioral consequence; adding a stdio
  per-request timeout is a separate concern, out of scope (§3).
- **Rollback:** revert the commit — `readCapped` returns to `web.ts`, MCP reads return to
  `res.text()`/`res.json()` + `createInterface`. Isolated to `web.ts`, `lib/read-capped.ts`, `mcp.ts`
  and their tests; no kernel, no dependency, no other extension touched.
