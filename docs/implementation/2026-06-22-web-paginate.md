# Implementation: web-paginate — `start_index` continuation for the web fetch tool

Status: closed
Closing-commit: 64f9baa (on branch 20260622webpaginate-dev-r1)
Closed-on: 2026-06-22

Closeout results: `npm test` exit 0 (525 tests pass, offline, no `ANTHROPIC_API_KEY`;
11 new tests added to `test/web.test.ts`). `npm run typecheck` exit 0. All design §7
acceptance criteria covered. Deviation flagged at T8/clamp: design crit 8's
"non-numeric value behaves identically to start_index: 0" — the kernel's integer
schema validator (`src/kernel/validate.ts:46-54`) coerces numeric strings but
*rejects* a truly non-numeric value before `execute` runs, so a non-numeric
`start_index` is rejected with "Invalid arguments for fetch_url" rather than
clamped to 0. This is the safe outcome (never reads at a garbage offset) and the
defensive `Math.max(0, …)` + `Number.isFinite` clamp still protects the negative
and omitted/undefined paths. The crit-8 test was adjusted to assert this real
contract (negative → window identical to 0; non-numeric → validation error).
Deferred: host.ts registration (none needed — `web` already in `BUILTIN_EXTENSIONS`,
no new extension id); CLAUDE.md `web` bullet clause + README (batch integration step).

Slug: `2026-06-22-web-paginate`
Design: `docs/design/2026-06-22-web-paginate.md` (Status: PASSED)

This guide takes a fresh agent through TDD development of the `start_index`
continuation feature. It introduces **no requirement absent from the design** —
every task traces to a design Deliverable (§2) or Acceptance Criterion (§7).
Read the design first; this guide assumes it.

> **BATCH MODE (CRITICAL).** Do **NOT** modify `src/host.ts`, `CLAUDE.md`, or
> `README.md`. `web` is already registered in `BUILTIN_EXTENSIONS` and this
> change adds **no new extension id**, so there is nothing to register. The
> CLAUDE.md `web` clause and any README reconciliation are **deferred to a
> separate batch-integration step**. Do **not** bump the README extension count.
> Only touch: `src/extensions/web.ts`, `test/web.test.ts`, and this doc.
> Tests load the extension directly via `host.use("web", web)` (already the
> pattern in `test/web.test.ts`) and must not depend on `BUILTIN_EXTENSIONS`.
>
> **Deliberate deviation from design §2 (flagged):** the design names a *new*
> `test/web-paginate.test.ts` (design `:60`, `:224`, `:392`). This guide instead
> **consolidates that suite into the existing `test/web.test.ts`** — to reuse its
> in-file `node:http` fixture server (`/big` etc.) and to reconcile the existing
> truncation-marker test in place (see §5) rather than fork a parallel fixture.
> Coverage is identical (all of unit `readCapped`, the schema assertion, e2e
> paging, and the kill switch land in `web.test.ts`), so the design §2
> deliverable "`test/web-paginate.test.ts` — offline `node:test` suite" **is
> satisfied in `test/web.test.ts`**; tick that checkbox accordingly at T10. No
> file named `web-paginate.test.ts` is created.

---

## 1. Task Index

Maps every design Deliverable (design §2, `docs/design/2026-06-22-web-paginate.md:49`–`80`)
and every Acceptance Criterion (design §7, `:297`–`356`) to a phase task.

| Design Deliverable (§2) | Acceptance (§7) | Phase / Task |
| --- | --- | --- |
| `readCapped` gains a `startIndex` param (stream-skip then collect ≤ `maxBytes`) | crit 2, 3, 4, 11 | P1 / T3, T7 |
| `fetch_url` schema gains optional `start_index` (integer, default 0, byte offset) | crit 1 | P1 / T2, T8 |
| Truncated branch emits `continue with start_index=N` hint replacing `TRUNCATION_MARKER` | crit 5, 6 | P1 / T4, T5, T9 |
| `readCapped` + continuation-hint builder exported as **named** exports (test seam, mirrors `recovery.ts`) | crit 2, 3, 4, 5 | P1 / T7, T9 |
| `test/web-paginate.test.ts` (design §2 `:60`) — **consolidated into `test/web.test.ts`** (extended): unit `readCapped`, schema assertion, e2e paging, kill-switch | all | P1 / T2–T6 |
| Kill switch `EAGENT_WEB_PAGINATE=off` restores legacy behavior (ignore `start_index`, emit marker) | crit 9 | P1 / T6, T9 |
| host.ts registration — **(deferred to batch integration)**; no new id, nothing to register | — | — (not in this phase) |
| Command — **none** (`/fetch` untouched; extends existing `fetch_url`) | crit 10 | P1 (negative: no new registration) |
| CLAUDE.md / README inventory — **(deferred to batch integration)**; count unchanged | — | — (not in this phase) |
| `docs/implementation/2026-06-22-web-paginate.md` — this doc + closeout notes | crit 11 | P1 / T10 |

Acceptance crit 7 (past-the-end empty window, no hint) → T2/T4 + T9. Acceptance
crit 8 (negative/NaN clamps to 0) → T4 + T9. Acceptance crit 10 (clean teardown)
→ T6. Acceptance crit 11 (suite green offline) → T10 exit gate.

---

## 2. Phase Breakdown

This feature is two small edits to one file (`src/extensions/web.ts` — thread
`startIndex` through `readCapped`, add `start_index` to the schema, swap the
marker for a hint on truncation) plus extensions to one test file
(`test/web.test.ts`). It is the smallest independently-committable unit that
leaves `npm test` green and maps to the entire Deliverables block. It is **a
single Phase** — there is nothing genuinely separable (the schema, the reader,
and the hint are one coherent behavior change; splitting them would leave an
intermediate state where the schema advertises a parameter the reader ignores).

### Phase 1 — `start_index` continuation for `fetch_url` (single Phase)

**Entry condition.** Design PASSED (it is). On the current tree, before any
change:
- `npm test` exits 0,
- `npm run typecheck` exits 0.
Establish this baseline first (T1) so any later red is attributable to this change.

**Design references.**
- Deliverables: design §2 `:49`–`80`.
- Key Design Decisions D1–D4: §4 `:111`–`219` (D1 extend `fetch_url` not new tool;
  D2 stream-and-discard skip, bounded memory; D3 continuation hint replaces
  marker, `N = startIndex + bytesShown`; D4 byte offset).
- Assumptions: §5 `:222`–`242` (past-the-end legal → empty window, not truncated,
  no hint; negative/NaN clamps to 0 via `Math.max(0, Number(...))`).
- Acceptance Criteria: §7 `:297`–`356`.
- Risks / kill switch: §8 `:359`–`394` (`EAGENT_WEB_PAGINATE=off`).

**Current code anchors** (read before editing):
- `readCapped` — `src/extensions/web.ts:49`–`80` (signature `(body, maxBytes)`;
  decodes per-chunk with `{ stream: true }`, last chunk `{ stream: false }`;
  cancels reader in `finally`).
- `TRUNCATION_MARKER` = `"\n…[truncated]"` — `web.ts:27`.
- `fetch_url` `parameters` schema — `web.ts:93`–`115`.
- `maxBytes` clamp pattern `Math.max(0, Number(args.maxBytes ?? …))` — `web.ts:125`.
- content assembly (where the marker is appended) — `web.ts:163`–`166`.
- `/fetch` command's `readCapped(res.body, DEFAULT_MAX_BYTES)` call — `web.ts:202`
  (must keep compiling; pass no `startIndex` → defaults to 0, behavior unchanged).

---

#### Task list, in TDD order

Every **(test)** task names the **business invariant** it protects and **precedes**
the **(impl)** task that satisfies it. Tests are added to the existing
`test/web.test.ts` (extend, do not replace — keep the five existing tests green).
The unit tests of `readCapped` import it as a **named export** from
`../src/extensions/web.js` (the export is added in T7), mirroring how
`recovery.ts` exports `recoveryHint`/`annotate` for direct unit testing.

For the unit tests, build an in-memory `ReadableStream<Uint8Array>` over known
`Uint8Array` chunks — **no network**. A small local helper such as:

```ts
function streamOf(...chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) { for (const c of chunks) controller.enqueue(c); controller.close(); },
  });
}
const bytesOf = (s: string) => new TextEncoder().encode(s);
```

keeps each test self-contained and deterministic (`ReadableStream.from(...)` is
an acceptable alternative if available in the runtime).

---

**T1 — (baseline, no edit).** Confirm the entry condition: run `npm test` and
`npm run typecheck`; both must exit 0 before touching anything.
- Acceptance: `npm test` exit 0; `npm run typecheck` exit 0.

---

**T2 — (test) Schema advertises `start_index`** — protects design crit 1.
**Business invariant:** *the model is told `fetch_url` accepts an optional byte
offset `start_index` that defaults to 0* — i.e. the paging capability is
discoverable and backward-compatible at the contract level. Add a test that
loads `web` via `host.use("web", web)` and inspects the registered tool spec
(`agent.tools` / the tool's `spec.parameters`). Assert:
`tool.spec.parameters.properties.start_index` exists, is `type: "integer"`, has
`default: 0`, and its `description` names **bytes** (`assert.match(desc, /byte/i)`).
Precedes T8 (the schema edit).
- Acceptance: `node --import tsx --test test/web.test.ts` shows this test
  present and **failing** (red) before T8 (`start_index` not yet in schema).

**T3 — (test) `readCapped` with `startIndex = 0` is byte-identical to today** —
protects design crit 2 (backward compat). **Business invariant:** *omitting /
zeroing `start_index` reproduces today's exact window* — no existing caller
changes behavior. Using `streamOf` over a known multi-chunk body:
- under-cap body: `readCapped(stream, large, 0)` → `text` equals the full source,
  `truncated === false`;
- over-cap body: `readCapped(stream, maxBytes, 0)` → `bytes === maxBytes`,
  `truncated === true`, `text` equals the first `maxBytes` bytes decoded.
Precedes T7 (the `startIndex` signature change — the test must still pass after,
proving no regression).
- Acceptance: this test **red** before T7 (named export `readCapped` not yet
  importable / signature differs), **green** after.

**T4 — (test) `readCapped` skips `startIndex` bytes, incl. boundary-straddle and
past-the-end** — protects design crit 3, 4, 7. **Business invariant:** *the
window starts at exactly byte `start_index` and spans the next ≤ `maxBytes`
bytes, with no gap or overlap, computed in bytes (D4)* — the core paging
arithmetic. Cases:
- **crit 3:** 30-byte known stream; `readCapped(stream, 10, 10)` → `text` equals
  source bytes `[10,20)` exactly (`assert.equal` on the decoded substring),
  `truncated === true` (10 bytes remain after the window), `bytes === 10`.
- **crit 4 (boundary-straddle):** chunk sizes chosen so a chunk crosses the
  `startIndex` boundary (e.g. 7-byte chunks, `startIndex = 10`); the window still
  begins at exactly byte `start_index` (`assert.equal` decoded window vs. source
  slice). This protects the discard-boundary detail (design D2 `:163`–`169`):
  only the prefix of the straddling chunk is dropped; its remainder feeds the
  window.
- **crit 7 (past-the-end):** `startIndex` ≥ body length → `text === ""`,
  `bytes === 0`, `truncated === false` (nothing remains ⇒ not truncated).
Precedes T7.
- Acceptance: red before T7, green after; `node --import tsx --test test/web.test.ts`.

**T5 — (test) Continuation hint carries the right `N` and replaces the marker** —
protects design crit 5 (and underpins crit 6). **Business invariant:** *on a
truncated window the tool hands the model an actionable next offset
`N = startIndex + bytesShown`, not a dead-end marker* — the whole reason the
feature exists (D3). Two layers:
- **unit (hint builder):** import the named continuation-hint builder from
  `../src/extensions/web.js` (added in T9). For `startIndex = 0, bytesShown = 100`
  assert the string contains `start_index=100`; for `startIndex = 100,
  bytesShown = 100` assert it contains `start_index=200`; assert it does **not**
  contain `…[truncated]`.
- **integration (via agent loop):** through `host.use("web", web)` + the
  `/big` fixture with `maxBytes` < body, the returned `tool_result` content
  matches `/start_index=\d+/` with the computed integer and does **not** match
  `/…\[truncated\]/`.
Precedes T9 (the hint export + content-assembly edit).
- Acceptance: red before T9, green after.

**T6 — (test) End-to-end paging reaches the tail; clamps; kill switch; teardown** —
protects design crit 6, 8, 9, 10. Reuses the existing `node:http` fixture-server
pattern already in `test/web.test.ts` (the `/big` route serves `"X".repeat(5000)`;
add a route with **distinguishable** bytes if needed to prove tail content — e.g.
a body whose first half differs from its second half, so a tail window is
provably the tail). **Business invariants:**
- **crit 6 (e2e paging reaches the tail):** *chained `fetch_url` calls walk the
  whole body with no gap or overlap.* Script two `agent.run` turns: turn 1
  fetches with `maxBytes` < N → result contains a `start_index=` hint; turn 2
  fetches the **same URL** with that offset → returns the **tail** bytes and,
  when the tail fits in one window, contains **no** continuation hint. Assert the
  concatenation of the two windows covers the whole body with no gap (assemble
  the payload portions and compare to the known body).
- **crit 8 (negative/NaN clamps to 0):** `start_index: -5` and a non-numeric
  value each produce a window **identical** to `start_index: 0` (design §5 clamp
  `Math.max(0, Number(...))`).
- **crit 9 (kill switch restores legacy output):** with
  `process.env.EAGENT_WEB_PAGINATE = "off"` set **before** `host.use("web", web)`
  (restore in `finally`), a truncated fetch's content matches `/…\[truncated\]/`
  and does **not** match `/start_index=/`, and a passed `start_index` is ignored
  (window starts at byte 0). **Business invariant:** *the kill switch yields
  byte-for-byte today's behavior.*
- **crit 10 (clean teardown):** after loading `web`, `await host.dispose()` does
  not throw. **Business invariant:** *this change adds no new registration that
  leaks on teardown* (no new tool, no new command, no new hook).
Precedes T8/T9 (where the execute body reads `start_index`, clamps, threads it,
and branches on the kill switch).
- Acceptance: red (paging/clamp/kill-switch parts) before T8/T9, green after;
  the existing teardown assertion already passes.

**T7 — (impl) Thread `startIndex` through `readCapped` (skip-then-collect) and
export it.** Satisfies T3, T4. In `src/extensions/web.ts`:
- Change the signature to
  `readCapped(body, maxBytes, startIndex = 0)` and **export it as a named export**
  (`export async function readCapped(...)`) so the unit tests import it
  (mirrors `recovery.ts`'s exported helpers; deliverable §2 `:56`–`59`). Keep the
  existing `default export activate` intact.
- Skip logic (stream-and-discard, design D2 — **never buffer the whole body**,
  preserve O(maxBytes) memory): before collecting the window, consume chunks and
  count consumed bytes until `startIndex` bytes have passed. When a chunk
  **straddles** the boundary, drop only its leading `startIndex - consumed` bytes
  (`value.subarray(offset)`) and feed the remainder into the existing
  window-collection loop. Do **not** decode skipped bytes (byte-count only — D4).
- After the skip, collect up to `maxBytes` exactly as today (the existing
  per-chunk `decode({stream:true})` / final `decode({stream:false})` logic,
  applied to post-skip bytes). `truncated` stays "more bytes remained after the
  window."
- Past-the-end (`startIndex` ≥ body length): the skip consumes the whole stream,
  the collect loop sees `done` immediately → `text === ""`, `bytes === 0`,
  `truncated === false`.
- Keep the `finally { await reader.cancel().catch(()=>{}); reader.releaseLock(); }`
  cleanup, and keep honoring `ctx.signal` (the skip is part of the same streamed
  read, so abort works mid-skip — design §5 `:231`).
- Update the `/fetch` command call site (`web.ts:202`) only if needed: passing no
  third arg defaults `startIndex` to 0, so it stays unchanged (verify it still
  compiles).
- Acceptance: `node --import tsx --test test/web.test.ts` — T3 and T4 green;
  the five pre-existing tests still green. `npm run typecheck` exit 0.

**T8 — (impl) Add `start_index` to the `fetch_url` schema and read+clamp it in
`execute`.** Satisfies T2, and the clamp half of T6 (crit 8). In `web.ts`:
- In `parameters.properties` (`web.ts:93`–`115`) add:
  `start_index: { type: "integer", default: 0, description: "Byte offset to start
  reading the response body from (default 0). Use the value from a previous
  fetch's 'continue with start_index=N' hint to read the next window." }`.
  `start_index` is **not** added to `required`.
- In `execute`, read and clamp:
  `const startIndex = Math.max(0, Number(args.start_index ?? 0));` (mirrors the
  `maxBytes` clamp at `web.ts:125`; `Number(undefined|NaN) → NaN`, `Math.max(0,
  NaN) → NaN` — guard so non-numeric → 0, e.g. `Number.isFinite` check or
  `|| 0`; ensure `start_index: -5` and a non-numeric both yield 0 per crit 8).
- Pass `startIndex` into the `readCapped(res.body, maxBytes, startIndex)` call
  (`web.ts:153`).
- Acceptance: `node --import tsx --test test/web.test.ts` — T2 green, clamp cases
  of T6 green. `npm run typecheck` exit 0.

**T9 — (impl) Continuation hint replaces the marker on truncation; kill switch.**
Satisfies T5, and the hint/kill-switch halves of T6 (crit 6, 9). In `web.ts`:
- Add a small **named, pure** continuation-hint builder, e.g.
  `export function continuationHint(nextIndex: number): string` returning
  `` `\nmore content available — continue with start_index=${nextIndex}` `` (exact
  prose per design §1/§4 `:42`–`45`, `:177`; the load-bearing token the tests and
  the model key on is `start_index=<N>`). Exporting it is the test seam
  (deliverable §2 `:56`–`59`); it is the *same* string the execute body appends.
- Read the kill switch at the top of `execute` (or guard the branch):
  `const paginate = process.env.EAGENT_WEB_PAGINATE !== "off";` (default on,
  shape matches `EAGENT_PRUNE`/`EAGENT_RECOVERY` — design §8 `:361`).
- In the content-assembly branch (`web.ts:163`–`166`), when `truncated`:
  - if `paginate`: append `continuationHint(startIndex + bytes)` —
    `N = startIndex + bytesShown` where `bytesShown` is the window's byte count
    (the `bytes` returned by `readCapped`); do **not** append `TRUNCATION_MARKER`.
  - else (`EAGENT_WEB_PAGINATE=off`): append `TRUNCATION_MARKER` exactly as today.
  - When **not** truncated (incl. the past-the-end empty window): append neither —
    no continuation hint (design §5 / crit 7).
- When `paginate` is off, also **ignore** `start_index` so the window starts at
  byte 0 (crit 9): under the kill switch, pass `startIndex = 0` (or `undefined`)
  into `readCapped` regardless of the arg. Keep this branch minimal and local to
  `execute`.
- Acceptance: `node --import tsx --test test/web.test.ts` — T5, T6 fully green;
  the five pre-existing tests still green (note: the existing "size cap truncates"
  test at `web.test.ts:87`–`103` asserts `/…\[truncated\]/`; see **Regression
  Protection** — that test must be reconciled because the default-on behavior now
  emits the hint, not the marker). `npm run typecheck` exit 0.

**T10 — (verify + closeout).** Run the full gate; fill closeout notes in this doc.
- Acceptance (Phase exit gate, design crit 11): `npm test` exit 0 (new + all
  pre-existing tests green, offline, no `ANTHROPIC_API_KEY`); `npm run typecheck`
  exit 0. Then tick the design §2 Deliverables — including the
  "`test/web-paginate.test.ts` — offline `node:test` suite" item, which is
  **satisfied by the consolidated tests in `test/web.test.ts`** (see the BATCH
  MODE deviation note); annotate that checkbox with "(consolidated into
  test/web.test.ts)" rather than leaving it blocked on a non-existent file — and
  record `npm test` / `npm run typecheck` results and the closing-commit sha in
  the header of this doc.

**Exit condition.** `npm test` exits 0 (extended `test/web.test.ts` plus all
pre-existing tests green) **and** `npm run typecheck` exits 0; `start_index`
advertised in the `fetch_url` schema; truncated default-on output carries the
`start_index=N` hint and not `…[truncated]`; `EAGENT_WEB_PAGINATE=off` restores
legacy output; `host.dispose()` after loading `web` does not throw. No edit to
`src/host.ts`, `CLAUDE.md`, or `README.md`.

---

## 3. Engineering Constraints Index

- **House conventions** (CLAUDE.md "House conventions"):
  - **ESM + NodeNext** — `.js` import specifiers even for `.ts` files
    (`import web from "../src/extensions/web.js"`, `import { readCapped, … } from
    "../src/extensions/web.js"`). Required by `module: NodeNext` +
    `verbatimModuleSyntax`.
  - **Strict TypeScript** — `strict`, `noUncheckedIndexedAccess`,
    `noImplicitOverride`, `noFallthroughCasesInSwitch`. **No `any`** — model the
    types (e.g. `Uint8Array`, `ReadableStream<Uint8Array>`,
    `string | number | undefined` for `args.start_index`).
  - **Zero runtime dependencies except `jiti`** — pure Node only. This feature
    uses `fetch`, `ReadableStream`, `TextDecoder`/`TextEncoder` — all already in
    `web.ts` / Node. Add **no** npm dependency.
  - **Offline `node:test` via `tsx`** — every test runs offline against
    `MockProvider` (`makeHarness`); the in-memory `ReadableStream` unit tests and
    the `node:http` fixture server keep it network-free and key-free.
- **Capability gate** — unchanged. `fetch_url` stays gated on `net:fetch`
  (`web.ts:92`); `start_index` adds no side effect, so **no new capability**
  (design §3 `:103`). The existing "net:fetch gate blocks the tool" test
  (`web.test.ts:119`–`136`) must stay green.
- **Kill switch** — `EAGENT_WEB_PAGINATE=off` (read inside `execute`, shape of
  `EAGENT_PRUNE`/`EAGENT_RECOVERY`).
- **Dispose loop that never throws** — this change registers nothing new, so the
  existing `web` teardown is unchanged; do not add a throwing teardown.
- **Bounded-memory guarantee** — the skip is **stream-and-discard**, never
  buffer the whole body (design D2). Memory stays O(maxBytes) regardless of
  `start_index` or body size. This is a load-bearing invariant, not an
  optimization.
- **Commit conventions** (SKILL.md): `feat(phase1):` for the Phase opener,
  `fix(phase1-roundR): <keyword>` for within-round fixes; include `npm test` and
  `npm run typecheck` results as trailers; **no mention of AI/model/tooling** in
  commit messages. Branch off (do not commit on a default/protected branch);
  commit/push only when the user asks.

---

## 4. Data / Fixture Dependencies

- **Reuse `test/helpers.ts`** — `makeHarness({ responder, fallback })`,
  `autoUI`, `silentLogger`, and `MockProvider` responder scripting. No new
  harness. Load the extension with `await host.use("web", web)` and drive it with
  scripted `toolCalls` exactly as the existing `web.test.ts` cases do.
- **Reuse the existing `node:http` fixture server** already in `test/web.test.ts`
  (`before`/`after`, ephemeral port, the `hits[]` recorder, the `/hello`,
  `/big`, `/notfound`, `/echo` routes, and the `lastToolResult(messages)`
  helper). For the e2e tail-paging test (crit 6) you may add **one** route with a
  body whose two halves are distinguishable (so a tail window is provably the
  tail) — keep it small and in-process; do not add committed fixture files.
- **In-memory `ReadableStream`** for the `readCapped` unit tests (`streamOf` /
  `bytesOf` helpers above, or `ReadableStream.from`). No network, no API key.
- **No committed fixtures, no disk I/O, no `EAGENT_WORKSPACE`** needed (unlike
  the `recovery` live tests) — `fetch_url` reads the network/stream, not the
  filesystem.

---

## 5. Regression Protection

The whole suite (`npm test`) must stay green. Specific watch points:

- **`test/web.test.ts` pre-existing cases (`:73`–`156`)** — the five existing
  tests (`GET /hello`, size-cap truncation, 404 error, net:fetch gate, POST
  echo) must stay green. **One requires reconciliation, not a behavior bug:** the
  **"size cap truncates the body and marks it truncated"** test (`:87`–`103`)
  asserts `assert.match(result.content, /…\[truncated\]/)`. With the feature
  default-on, a truncated fetch now emits the `start_index=N` continuation hint
  **instead of** the marker (design D3). Reconcile this as part of T9 by updating
  that assertion to match the new default behavior — e.g. assert
  `/start_index=\d+/` (and that the body is shorter than the full 5000 bytes,
  which the test already checks) — **and/or** keep a marker assertion under an
  explicit `EAGENT_WEB_PAGINATE=off` path. This is an intended, design-sanctioned
  output change (§4 D3, §8), not a regression to suppress; the new T5/T6 tests
  are the positive coverage for the hint. Do not weaken the truncation assertion
  to nothing — keep proving the body was capped.
- **`net:fetch` gate test (`:119`–`136`)** — must stay green: `start_index` adds
  no capability and no new code path before the gate.
- **Teardown** — `host.dispose()` across the suite must not throw; this change
  adds no new registration (crit 10).
- **No host/kernel suites are touched** — because `src/host.ts` is not modified,
  `test/host.test.ts` and the builtin-registration expectations are untouched
  (do not change the README extension count). If any host/builtin test references
  a `web` extension count or inventory, that is the batch-integration step's
  concern, not this Phase's.
- **Confirm by running `npm test`** and reading any failure; the only expected
  delta is the reconciled truncation assertion in `test/web.test.ts`.
