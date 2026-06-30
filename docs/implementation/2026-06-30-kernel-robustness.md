# Implementation — kernel defensive-robustness pass (FRESH-1, FRESH-2, FRESH-4)

**Slug:** `2026-06-30-kernel-robustness` (identical to the design doc). **Design:**
`docs/design/2026-06-30-kernel-robustness.md`.

## 1. Task Index

| Design artifact | Where in design doc | Realized in Phase |
|---|---|---|
| Deliverable FRESH-1 (abort → `reason:"stop"`, no emit/throw) | §2 + D1 (§4) | Phase 1 |
| Deliverable FRESH-2 (clamp `maxConcurrency` ≥ 1) | §2 + D2 (§4) | Phase 1 |
| Deliverable FRESH-4 (corrupt-store backup-aside) | §2 + D3 (§4) | Phase 2 |
| Deliverable: kernel `< 2200` via comment-offset | §2 + D4 (§4) | Phase 1 (the offset lives in `run()`) |
| Acceptance Criteria 1–3, 5 | §7 | Phase 1 |
| Acceptance Criteria 4, 5 | §7 | Phase 2 |

`<TEST-CMD>` = `npm test` (node:test via tsx; offline, MockProvider). Per-file:
`node --import tsx --test test/<file>.test.ts`. Other gates: `npm run typecheck`, `npm run eval`.

## 2. Phase Breakdown

### Phase 1 — `agent.ts` loop robustness (FRESH-1 + FRESH-2)

**Entry condition:** clean tree on `init`; baseline `npm test` green (1136 pass / 0 fail / 1 skip),
`npm run typecheck` 0, kernel metric 2198.

**Design references:** D1 (FRESH-1, design §4 "D1 —"), D2 (FRESH-2, "D2 —"), D4 (line-ceiling offset,
"D4 —"), AC#1/#2/#3 (§7), Scope Boundary (§3).

**Task list (TDD order — test tasks first):**

1. **[test] FRESH-1 cancel-path test** in `test/agent.test.ts`. Add a test that:
   - Defines an inline provider whose `stream(req)` `yield`s one `{type:"text_delta", text:"hi"}`, then
     on the **next** iteration `throw`s `new DOMException("aborted","AbortError")` (or any error) **iff**
     `req.signal.aborted` — emulating a real `fetch` provider rejecting an in-flight stream. (If not
     aborted, yield a normal `done` so the non-abort case is well-defined.)
   - Registers a `text_delta` hook listener that calls `agent.stop()` (`agent.hooks.on("text_delta",
     () => agent.stop())`), so the abort lands **mid-stream** (the provider's next yield throws).
   - Registers an `"error"` event listener that counts invocations.
   - **Business invariant protected:** a user cancel that lands *while the provider stream is being
     consumed* is a clean stop, not a failure. Asserts: `await agent.run(...)` **resolves** (does not
     throw), the result `reason === "stop"`, and the `"error"` listener was invoked **0** times.
2. **[test] FRESH-1 genuine-error regression** in `test/agent.test.ts` (may be folded into the same or
   a sibling test). Provider throws pre-commit (before any event) with the signal **not** aborted.
   **Invariant:** a real provider failure still escalates. Asserts `agent.run()` **rejects** and (via an
   `agent_end`/`error` capture) `reason === "error"`. (This re-confirms the semantics already pinned at
   `test/agent.test.ts:763`; keep that test passing.)
3. **[test] FRESH-2 clamp test(s)** in `test/agent.test.ts`. Two cases — `maxConcurrency: 0` and
   `maxConcurrency: -1` — each driving a **two**-`tool_call` parallel wave (two non-sequential tools).
   **Invariant:** an invalid concurrency must not crash dispatch; both tools still run. Asserts both
   tool executions occurred (e.g. both results present / both side-effect counters incremented) and the
   run completed with a normal reason (no thrown `TypeError`). Co-locate near the existing
   `maxConcurrency` tests (`test/agent.test.ts:420,475`).
4. **[impl] FRESH-1** — in `src/kernel/agent.ts`, rewrite `run()`'s `catch (err)` block (currently
   `agent.ts:337-340`) so that when `this.#abort?.signal.aborted` is true it sets `reason = "stop"` and
   does **not** emit `"error"` and does **not** re-throw (control falls through to `finally` then the
   `return`); otherwise it keeps the exact existing behavior (`reason = "error"`; `await
   this.hooks.emit("error", { where: "agent.run", error: err })`; `throw err`).
5. **[impl] FRESH-1 comment offset (D4)** — rewrite the in-loop abort-handling comment at
   `agent.ts:238-243` (6 lines) to ~2 lines, updated to state there are now **three** abort-handling
   sites (the two in-loop checks + the `run()` catch), all ending the run `reason:"stop"`. This offsets
   the FRESH-1 catch growth. **Do not touch `flush()` or any unrelated comment** (Scope §3).
6. **[impl] FRESH-2** — change `agent.ts:132` from `this.maxConcurrency = opts.maxConcurrency ??
   Infinity;` to `this.maxConcurrency = Math.max(1, opts.maxConcurrency ?? Infinity);`. (One line, net
   0.) Scope note: this floors `<= 0` **and**, as a harmless bonus, fractional `(0,1)` to `1`
   (`Math.max(1, 0.5) === 1` — those also currently crash via the empty pool). `NaN` is **out of the
   declared `<= 0` scope** (`Math.max(1, NaN) === NaN`, and `NaN <= 0` is `false`) — it is a far less
   plausible operator misconfig than `0`/negative, and neutralizing it would cost a temp var (a kernel
   line the budget cannot spare); left out deliberately, consistent with the design's `<= 0` framing.
7. **[verify] kernel ceiling** — re-run the kernel-surface line check; the agent.ts net must keep the
   `src/kernel/` total `< 2200` (expect ≈ 2197 after Phase 1: +3 catch −4 comment +0 clamp = −1 →
   2197). If over, source the remaining offset **only** from other comment lines inside `run()` —
   never `flush()`, never a ceiling raise (escalate instead).

**Per-task acceptance commands:**
- `node --import tsx --test test/agent.test.ts` exit 0 (existing + the 3 new tests).
- `node --import tsx --test test/kernel-surface.test.ts` exit 0 (the `< 2200` assertion + export pins).
- `npm run typecheck` exit 0.

**Exit condition:** the three new `agent.test.ts` tests pass; `agent.test.ts:763` still passes;
kernel-surface green (`< 2200`); typecheck 0; `npm test` green.

### Phase 2 — `store.ts` corrupt-file safety (FRESH-4)

**Entry condition:** Phase 1 merged; tree green.

**Design references:** D3 (FRESH-4, design §4 "D3 —"), AC#4 (§7), Deliverable FRESH-4 (§2), Scope §3.

**Task list (TDD order — test tasks first):**

1. **[test] new `test/store.test.ts`** — drive everything through the exported `FileBackend` (import
   `FileBackend` from `../src/kernel/store.js`; `FileStore` is private). Use a temp dir
   (`node:fs.mkdtempSync(join(tmpdir(), "eagent-store-"))`) per the existing test conventions; the
   namespace file path is `join(root, sanitize(namespace) + ".json")` where `sanitize` (`store.ts:98-100`)
   *replaces* each non-`[a-zA-Z0-9_.-]` char with `_` (no case change) — choose a namespace with no
   special chars so the file name is predictable (e.g. `"ns"` → `ns.json`). Cases:
   - **(a) absent file:** `const s = backend.open("ns")`; assert `s.keys()` is `[]` and **no** file
     exists at `root/ns.json` yet (open is a pure read for the absent case); then `s.set("k", 1)` and
     assert the file now exists and round-trips. **Invariant:** first-run absence is silent, not a
     corrupt event.
   - **(b) valid JSON:** pre-write `root/ns.json` = `{"k":"v"}`; `backend.open("ns").get("k")` === `"v"`.
     **Invariant:** a valid store loads unchanged.
   - **(c) corrupt JSON:** pre-write `root/ns.json` = a non-JSON string (e.g. `"{not json"`); open a
     **fresh** `FileBackend(root)` (so a new `FileStore` is constructed and `read()` runs) and
     `open("ns")`; assert: (i) the store is empty (`keys()` is `[]`); (ii) a sibling file matching
     `ns.json.corrupt-*` exists and **contains the original `"{not json"` bytes**; (iii) after
     `s.set("k2", 2)`, `root/ns.json` is fresh valid JSON containing `k2` and **not** the original
     corrupt bytes. **Invariant:** corrupt data is preserved (not destroyed by the next flush) and the
     store recovers to a working state.
   - Note: a fresh `FileBackend` per case is required because `FileBackend` caches one `FileStore` per
     namespace (`store.ts:56-58`), so `read()` only runs on first construction.
2. **[impl] FRESH-4** — in `src/kernel/store.ts`:
   - Add `existsSync` to the existing `node:fs` import (`store.ts:9`) — same import line, no new line.
   - Rewrite `FileStore.read()` (`store.ts:81-87`): `if (!existsSync(this.path)) return {};` then
     `try { return JSON.parse(readFileSync(this.path, "utf8")) as Record<string, unknown>; }` and on
     `catch` perform a **best-effort** `try { renameSync(this.path,
     \`${this.path}.corrupt-${process.pid}-${Date.now()}\`); } catch { /* best effort */ }` then
     `return {};`. Keep `read()`'s body as tight as possible (no standalone explanatory comment) so the
     net store.ts growth is ≈ +2 and **`flush()` stays untouched** (Scope §3).
3. **[verify] kernel ceiling** — re-run kernel-surface; total must stay `< 2200` (expect ≈ 2199 after
   Phase 2: 2197 + 2 = 2199). If 2200+, escalate (do not raise the ceiling; do not touch `flush()`).

**Per-task acceptance commands:**
- `node --import tsx --test test/store.test.ts` exit 0 (the 3 new cases).
- `node --import tsx --test test/kernel-surface.test.ts` exit 0.
- `node --import tsx --test test/memory.test.ts` exit 0 (memory uses `FileBackend` — regression).
- `npm run typecheck` exit 0.

**Exit condition:** `test/store.test.ts` passes all three cases; `memory.test.ts` green; kernel-surface
green (`< 2200`); typecheck 0; `npm test` green; `npm run eval` 5/5.

## 3. Engineering Constraints Index

- **Project engineering norms:** CLAUDE.md "House conventions" — ESM + NodeNext (`.js` import
  specifiers even for `.ts`), strict TypeScript (no `any`), zero runtime deps except `jiti`, tests via
  `node:test` run offline. **No Claude attribution in commits** (CLAUDE.md "House conventions" final
  bullet) — author identity only; no `Co-Authored-By`/`Claude-Session`/claude.ai trailers.
- **Four-corner subagent template:** `~/.claude/skills/three-loop-workflow/references/loop-3-development.md`.
- **Commit conventions:** SKILL.md "Commit conventions" — `feat(phaseN):`/`fix(phaseN):` opener,
  `fix(phaseN-roundR): <keyword>` within-round; `<TEST-CMD>`/`<ACCEPT-CMD>` results as trailers; no AI
  mention.
- **Kernel ceiling:** `test/kernel-surface.test.ts` (`< 2200`, metric = sum of `split("\n").length`).
  Re-run after every `src/kernel/*.ts` edit.

## 4. Data and Fixture Dependencies

- **Reuse:** `test/agent.test.ts` provider/tool helpers (`defineTool`, the `Agent` + `MockProvider`
  setup at the top of the file, and the `maxConcurrency` test scaffolding at `:420,:475`); the
  `node:test`/`node:assert` imports already in those files.
- **New:** an inline async-generator provider in the FRESH-1 test (yields one `text_delta`, throws on
  aborted next-iteration). A new `test/store.test.ts` file using `node:fs` (`mkdtempSync`, `writeFileSync`,
  `readFileSync`, `existsSync`, `readdirSync`) + `node:os.tmpdir` + `node:path.join`. No new npm
  dependency.

## 5. Regression Protection

- **Must stay green:** `test/agent.test.ts:282-303` (between-call `stop()` ⇒ `reason:"stop"`, unchanged
  path); `test/agent.test.ts:763` (pre-commit genuine error ⇒ reject + `reason:"error"`); the
  `maxConcurrency` tests (`:420,:475`); the full `test/kernel-surface.test.ts` (export pins + `< 2200`);
  `test/memory.test.ts` (exercises `FileBackend`); `npm run eval` (5/5).
- **Whole suite:** `npm test` must end at ≥ 1136 pass / 0 fail (new tests add to the count), 1 skip
  (the backend-gated self-improve integration test) unchanged.
