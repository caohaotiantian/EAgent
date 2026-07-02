# Implementation — cap MCP transport reads (SRV-4b / item ③)

**Slug:** `2026-07-02-mcp-read-caps` · Design: `docs/design/2026-07-02-mcp-read-caps.md`.

## 1. Task Index

| Design Deliverable (§2) | Design AC (§7) | Phase |
|---|---|---|
| Relocate `readCapped` → `src/extensions/lib/read-capped.ts`; web imports from lib | AC5, AC1 | P1 |
| `maxMcpReadBytes()` env helper (16 MiB) in `mcp.ts` | AC2, AC3 | P2 |
| HTTP `#readResponse` uses `readCapped(res.body)` + throw-on-truncate (SSE + JSON) | AC2, AC3 | P2 |
| stdio byte-bounded discard-to-newline line reader (exported pure step) | AC4 | P3 |
| `HANDOFF.md:142` correction (scope "un-offline-testable" to a live smoke) | — | P3 (closeout) |
| Tests: HTTP caps, stdio bound, relocated readCapped, suites green | AC1–AC6 | P1–P3 |

Design decisions: D1 (relocate to lib), D2 (move only `readCapped`), D3 (`maxMcpReadBytes` 16 MiB env),
D4 (throw on truncated HTTP), D5 (stdio discard-to-newline), D6 (cap both transports). Risks: §8.

## 2. Phase Breakdown

### Phase 1 — Relocate `readCapped` to `lib/` (pure, behavior-preserving move)

**Entry condition:** none (first Phase). Baseline green.

**Design references:** `docs/design/2026-07-02-mcp-read-caps.md` §2 (deliverable 1), §4 D1–D2, §7 AC5,
§6 (web-paginate governing design).

**Files:** `src/extensions/lib/read-capped.ts` (new), `src/extensions/web.ts` (remove `readCapped`,
import it), `test/read-capped.test.ts` (new — moved tests), `test/web.test.ts` (drop the moved tests +
its `readCapped` import).

**Task list (TDD order):**

1. **T1 (test — move the `readCapped` unit tests).** Create `test/read-capped.test.ts` importing
   `readCapped` from `../src/extensions/lib/read-capped.js` (and reusing the `streamOf`/`bytesOf`
   in-memory-stream helpers, currently `test/web.test.ts:11-20` — **move** them into the new file; they
   are used **only** by the readCapped tests, so they must be removed from `web.test.ts` too, see task 2).
   Move the four `readCapped` tests (`web.test.ts:207,224,232,244`) verbatim into it. *Invariant protected:* the
   byte-window semantics (`startIndex` skip, straddle-exact, past-the-end empty, under/over-cap window)
   survive the relocation unchanged. This test file **fails to import** until task 2 creates the module
   (RED). *Acceptance:* `node --import tsx --test test/read-capped.test.ts` exit 0 (after task 2).
2. **Implementation — move the function.** Cut `readCapped` (its full body, `web.ts:45-111`, including
   the doc-comment) into a new `src/extensions/lib/read-capped.ts` as `export async function readCapped(
   body: ReadableStream<Uint8Array>, maxBytes: number, startIndex = 0): Promise<{text:string;
   bytes:number; truncated:boolean}>`. In `web.ts` add `import { readCapped } from "./lib/read-capped.js"`
   and delete the local definition. Leave `DEFAULT_MAX_BYTES`, `TRUNCATION_MARKER`, and `continuationHint`
   in `web.ts` (web-only). Keep the `web.test.ts` `continuationHint` test + its `continuationHint` import;
   remove the moved `readCapped` tests, drop `readCapped` from the `web.test.ts` import line (`:6`), and
   remove the now-orphaned `streamOf`/`bytesOf` helpers (`:11-20`) — only the moved tests used them (grep
   `web.test.ts` to confirm no other reference before deleting).
3. **Gates.** `node --import tsx --test test/read-capped.test.ts test/web.test.ts` exit 0;
   `npm run typecheck` exit 0.

**Exit condition:** AC5 — `readCapped` lives in `lib/read-capped.ts`, imported by `web.ts` with its two
call sites (`web.ts:218,272`) unchanged; the moved unit tests pass from the new path; `test/web.test.ts`
(fetch_url / `/fetch` / pagination) stays green; typecheck 0.

### Phase 2 — Cap the HTTP transport reads

**Entry condition:** Phase 1 merged (`readCapped` importable from `lib/`).

**Design references:** §2 (deliverables 2–3), §4 D3–D4, §7 AC2–AC3, §8 (throw path, resources/read note).

**Files:** `src/extensions/mcp.ts` (helper + `#readResponse`), `test/mcp-http.test.ts` (SSE + JSON cap
tests + fixture extension).

**Task list (TDD order):**

> **CRITICAL cap-value constraint for T2/T3 (and the whole HTTP cap test).** The cap is read live on the
> **same** `#readResponse` path the handshake uses (`initialize` `mcp.ts:406`, `tools/list` `:415`,
> serialized results ~130+ bytes; a normal `tools/call` reply ~78 bytes). A tiny cap (e.g. 64) would make
> the **handshake itself** throw "exceeded" → the server never registers → every assertion becomes
> unreachable, and "a within-cap reply resolves normally" is impossible. So set `EAGENT_MAX_MCP_READ_BYTES`
> **above** the normal handshake/reply sizes and pad the oversized body **well above** the cap — e.g. cap
> `"2048"`, oversized payload ≥ 8 KiB. The env is set for the whole `try { … } finally { restore }` block
> (or `before`/`after`); the handshake and within-cap replies stay under 2 KiB and succeed.

1. **T2 (test, AC2 — HTTP SSE over-cap).** In `test/mcp-http.test.ts`, extend the in-process `node:http`
   fixture (`:41-101`) to answer a **designated** tool call with a `text/event-stream` body whose single
   `data:` payload is padded **≥ 8 KiB** (well over the test cap `EAGENT_MAX_MCP_READ_BYTES="2048"`;
   **restore in `finally`** per the env-restore convention). Assert that call resolves to an `isError`
   result whose text contains `"exceeded"`. Add a companion assertion that a **within-cap** SSE reply (a
   small `data:` payload, well under 2 KiB) parses and resolves normally — and that the handshake itself
   succeeds (the server registered its tools). *Invariant protected:* an oversized SSE body is capped and
   surfaced as a clean error, not OOM'd or mis-parsed, while normal-size reads (incl. the handshake) are
   unaffected. *Acceptance:* `node --import tsx --test test/mcp-http.test.ts` exit 0.
2. **T3 (test, AC3 — HTTP JSON over-cap).** Same fixture and cap: a designated call whose
   `application/json` body is padded ≥ 8 KiB → the call errors with `"exceeded"`; the handshake and the
   existing normal-JSON tests (under 2 KiB) still succeed. *Invariant:* the JSON branch is capped
   identically to SSE, and normal-size JSON is untouched.
3. **Implementation** in `src/extensions/mcp.ts`:
   - Add, near `HTTP_REQUEST_TIMEOUT_MS`/`MAX_RESOURCES`, an exported helper mirroring
     `providers/http.ts:16-21`:
     ```ts
     /** OOM-safety cap on a single MCP transport read (`EAGENT_MAX_MCP_READ_BYTES`,
      *  default 16 MiB — far above any legitimate MCP response/line; invalid/≤0 → default). */
     export function maxMcpReadBytes(): number {
       const n = Number(process.env.EAGENT_MAX_MCP_READ_BYTES);
       return Number.isInteger(n) && n > 0 ? n : 16 * 1024 * 1024;
     }
     ```
   - `import { readCapped } from "./lib/read-capped.js"`.
   - Rewrite `HttpTransport.#readResponse` (`:347-359`): if `res.body` is null, fall back to **today's
     per-branch** behavior — `text/event-stream` → `this.#parseSse(await res.text(), id)`, else
     `await res.json()` (this is `web.ts:272`'s single-branch fallback adapted to `#readResponse`'s two
     content-type branches; do not collapse them). Otherwise
     `const { text, truncated } = await readCapped(res.body, maxMcpReadBytes());` and
     `if (truncated) throw new Error(\`MCP HTTP response from "${this.#name}" exceeded ${maxMcpReadBytes()} bytes\`);`
     then branch on content-type: `text/event-stream` → `this.#parseSse(text, id)`; else
     `JSON.parse(text) as {…}` (equivalent to `res.json()` for a within-cap body — D4/§advisory). The
     throw propagates through `request()` (`:297`) to the tool `execute` catch (`:532-534`) → `fail(...)`.
4. **Gates.** `node --import tsx --test test/mcp-http.test.ts` exit 0; `npm run typecheck` exit 0.

**Exit condition:** AC2 + AC3 — oversized HTTP SSE and JSON reads error with `"exceeded"` under a small
cap; within-cap reads succeed; `maxMcpReadBytes()` matches the SRV-4 helper shape; typecheck 0.

### Phase 3 — Byte-bound the stdio transport reads + HANDOFF correction

**Entry condition:** Phase 2 merged (`maxMcpReadBytes()` present).

**Design references:** §2 (deliverables 4–5), §4 D5–D6, §7 AC4, §8 (stdio silent-drop residual).

**Files:** `src/extensions/mcp.ts` (exported pure line-step + wire into `StdioTransport`),
`test/mcp.test.ts` (bounded-reader unit test + fixture integration), `docs/HANDOFF.md:142` (correction).

**Task list (TDD order):**

1. **T4 (test, AC4 — bounded-reader unit test with a boundedness discriminator).** In `test/mcp.test.ts`,
   import the exported `createBoundedLineReader` (task 3). Drive it with **`Buffer` chunks** over an
   in-memory sequence: feed a single **no-newline run much larger than the cap** (e.g. cap `16`, feed 200
   bytes as ten `Buffer.from("x".repeat(20))` chunks), asserting after **every** chunk that
   `reader.buffered()` (a byte count) **stays ≤ cap** — the load-bearing discriminator: a
   "buffer-everything-then-discard" reader would let `buffered()` climb 20→40→…→200 and fail this — and
   that `reader.discarding()` becomes `true` once the cap is passed with no newline. Then feed
   `Buffer.from("\n")` followed by `Buffer.from(JSON.stringify({jsonrpc:"2.0",id:1,result:{}}) + "\n")`
   and assert `onLine` was called **exactly once** with that valid line (resync). Add a multibyte case:
   feed a valid line containing a non-ASCII char split across two chunks (e.g. the UTF-8 bytes of `"σ"`
   in `{"x":"σ"}` split mid-character) and assert the emitted line `JSON.parse`s intact (guards the
   whole-line-decode invariant). *Invariant protected:* a hostile no-newline flood cannot grow memory
   beyond the cap; the reader recovers on the next newline; and multibyte chars split across `data`
   chunks are not corrupted. *Acceptance:* `node --import tsx --test test/mcp.test.ts` exit 0.
2. **T5 (test, AC4 — fixture integration).** Extend the stdio `FIXTURE_SERVER` template
   (`test/mcp.test.ts`, the `node:readline` fixture ~`:100-136`) so a designated method writes a large
   **no-newline** blob to stdout **followed by a newline** (the `\n` is essential — without it the blob
   and the next response merge into one over-cap line and discard-to-newline would swallow the valid
   response too), then a valid newline-terminated response for the request. Set
   `EAGENT_MAX_MCP_READ_BYTES` **above** the normal handshake/response line sizes but **below** the flood
   (e.g. cap `"1024"`, flood ≥ 64 KiB; restored in `finally`) — the small cap must **not** be so small
   that the `initialize`/`tools/list` handshake lines (~130+ bytes, `test/mcp.test.ts:116-120`) get
   discarded, or activation never completes. Assert the request still resolves after the flood (the
   oversized line was dropped, not fatal). *Invariant:* the bounded reader integrated into
   `StdioTransport` drops an oversized line without breaking the surrounding round-trips.
3. **Implementation** in `src/extensions/mcp.ts`:
   - Add an exported, pure line-framing step — a small stateful helper factored for testing. Suggested
     shape: `export function createBoundedLineReader(cap: number, onLine: (line: string) => void)`
     returning `{ push(chunk: Buffer): void; buffered(): number; discarding(): boolean }`. **Buffer
     bytes, not a string** — this is load-bearing for both correctness and the byte-accurate observable:
     - Keep the residual as a **`Buffer`** (concatenate incoming chunks). Scan for the newline **byte**
       `0x0A`. For each complete line, `line.toString("utf8")` its bytes → `onLine(line)`. Because `0x0A`
       can never appear inside a UTF-8 multibyte sequence, splitting on the byte never bisects a
       character — so decoding **whole lines** avoids the partial-UTF-8-across-chunk corruption that a
       per-chunk `chunk.toString()` would cause (a split multibyte char would else break `JSON.parse` and
       silently drop the line).
     - `buffered()` returns the **residual `Buffer.length`** (a true byte count — the value the `cap`
       nominally bounds).
     - Overflow: if the residual (bytes since the last `0x0A`) exceeds `cap` with no newline, set the
       `discarding` flag and **drop** the residual; while discarding, drop all incoming bytes up to and
       including the next `0x0A`, then clear the flag and resume. So `buffered()` never exceeds `cap`.
     (The exact API may be adjusted in dev, but it MUST buffer bytes, decode only complete lines, and
     expose the retained-**byte** count + discard state for T4.)
   - In `StdioTransport`: replace `this.#rl = createInterface({ input: this.#child.stdout! }); this.#rl.on(
     "line", …)` (`:189-190`) with `const reader = createBoundedLineReader(maxMcpReadBytes(), (line) =>
     this.#onLine(line)); this.#child.stdout!.on("data", (c: Buffer) => reader.push(c));` (annotate
     `c: Buffer` — Node types the `data` payload as `any`, and CLAUDE.md forbids `any` cop-outs). Update `close()`
     (`:224-234`) to stop feeding the reader (remove the `#rl.close()`; the child kill + stdout end
     suffice — detach the `data` listener if a handle is retained). Drop the now-unused `createInterface`/
     `Interface` import and the `#rl` field. Keep `#onLine`, `#write`, `#failAll`, `#pending` unchanged.
4. **HANDOFF correction (deliverable 5).** Edit `docs/HANDOFF.md:142`: narrow "the SRV-4b MCP caps … are
   un-offline-testable by design" so the "un-offline-testable" claim applies to a **live hostile-server
   smoke** only — the cap-enforcement logic is offline-tested here (this Phase's tests).
5. **Gates.** `node --import tsx --test test/mcp.test.ts` exit 0; `npm run typecheck` exit 0.

**Exit condition:** AC4 — the bounded-reader unit test asserts the retained buffer stays ≤ cap under a
≫cap no-newline run and resyncs on the next newline; the fixture integration confirms normal round-trips
survive; `HANDOFF.md:142` corrected; the full stdio `test/mcp.test.ts` suite green (framing preserved).

**Whole-task exit (all phases):** AC1 (the four test files exit 0), AC6 (`npm test` / `npm run typecheck`
/ `npm run eval` exit 0; `src/kernel/` byte-identical via `node --import tsx --test
test/kernel-surface.test.ts`; no new dependency).

## 3. Engineering Constraints Index

- **Engineering norms:** `CLAUDE.md` "House conventions" — ESM + NodeNext (`.js` specifiers even for
  `.ts`; `./lib/read-capped.js`), strict TypeScript (model the reader/observable types; no `any`), zero
  runtime deps except `jiti` (`ReadableStream`/`TextDecoder`/stream events are stdlib), offline tests,
  capability gating unchanged (`mcp:call`/`mcp:read`). No Claude/AI attribution in commits.
- **Four-corner subagent template:** `references/loop-3-development.md`.
- **Commit conventions:** SKILL.md "Commit conventions" — `feat(phaseN):` / `fix(phaseN-roundR):
  <keyword>`; result trailers; no AI attribution.

## 4. Data and Fixture Dependencies

- P1: `test/web.test.ts:11-20` `streamOf`/`bytesOf` are **moved** into `test/read-capped.test.ts` (and
  removed from `web.test.ts`, since only the moved readCapped tests use them — see P1 task 2).
- P2: reuse the in-process `node:http` fixture in `test/mcp-http.test.ts:41-101` (add SSE + oversized-JSON
  branches; the current fixture only replies `application/json`, never SSE).
- P3: reuse the stdio `FIXTURE_SERVER` template in `test/mcp.test.ts` (~`:100-136`) + the temp-dir
  `before`/`after` env-set/`delete EAGENT_MCP_SERVERS` harness (`:173-187`). No new external fixtures.
- Env-restore: every test that sets `EAGENT_MAX_MCP_READ_BYTES` restores it in `finally` (or `after`),
  mirroring the SRV-4 `EAGENT_MAX_SSE_EVENT_BYTES` test and the `EAGENT_CHECKPOINT` restore pattern.

## 5. Regression Protection

- P1: `test/web.test.ts` (all fetch_url / `/fetch` / pagination / `continuationHint` tests) must stay
  green — the relocation is behavior-preserving.
- P2/P3: the existing `test/mcp-http.test.ts` (JSON round-trip, session id, accept header) and
  `test/mcp.test.ts` (stdio handshake, tools/list, tools/call echo, resources) must stay green — the cap
  is additive; within-cap behavior is unchanged and framing is preserved.
- Whole task: `npm test` (1195 pass / 0 fail / 1 skip) remains green; `test/kernel-surface.test.ts`
  confirms the kernel is untouched.
