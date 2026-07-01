# Implementation — optional semantic (embedding) memory recall (RW7b-1)

Status: closed
Closing-commit: 76dd386
Closed-on: 2026-07-01
Deferred: none in this slice (see the design closure for the deferred follow-ups). Phase 1 = commit
76dd386 (L3 closed in 1 clean round). Whole-project F review: pass (zero severe; searchTiers's 2 callers
both awaited, default byte-identical, no server break, no dep, no kernel change). Suite 1156 pass / 0
fail / 1 skip; memory 29/29; typecheck 0; eval 5/5. (Test-file IDE diagnostics were confirmed stale —
direct tsc exit 0.)

**Slug:** `2026-07-01-semantic-memory-recall` (identical to the design doc). **Design:**
`docs/design/2026-07-01-semantic-memory-recall.md`.

## 1. Task Index

| Design artifact | Where | Phase |
|---|---|---|
| `Embedder` type + `setEmbedder` hook + env-resolved fetch embedder | §2, D2, D4 | Phase 1 |
| `searchTiers` async semantic path (cosine) + fail-soft to lexical | §2, D1, D3 | Phase 1 |
| recall command + recall tool await; `EAGENT_MEMORY_EMBED=off` kill switch | §2 | Phase 1 |
| relevance.ts docstring correction | §2 | Phase 1 |
| Acceptance Criteria 1–4 | §7 | Phase 1 |

`<TEST-CMD>` = `npm test`. Per-file: `node --import tsx --test test/memory.test.ts`. Gates:
`npm run typecheck`, `npm run eval`.

## 2. Phase Breakdown

### Phase 1 — semantic recall (single phase)

**Entry condition:** clean tree on `chore/finish-followups-3`; baseline `npm test` green (1152 pass /
0 fail / 1 skip), typecheck 0, eval 5/5.

**Design references:** D1 (embed-on-recall + single-batch assumption), D2 (injectable, off-by-default,
fail-soft), D3 (cosine, topK-bounded), D4 (config + mock), §7 AC.

**Files:** `src/extensions/memory.ts`, `src/extensions/lib/relevance.ts` (one docstring line),
`test/memory.test.ts`. NO `src/kernel/` change.

**Task list (TDD order — tests first):**

1. **[test] a deterministic mock embedder + the fixtures** in `test/memory.test.ts`. Define a mock
   `Embedder`: a `(texts) => Promise<number[][]>` that maps each text to a small fixed-dim vector over
   a tiny controlled concept-vocabulary (e.g. bucket tokens into ~4 concept dims by a fixed keyword→dim
   map), so a **paraphrase** note (shares CONCEPT with the query but **no ≥3-char non-stopword surface
   token** — so `overlapScore` scores it 0) gets a high-cosine vector, while an **incidental** note
   (shares one surface token, low concept overlap) gets a low-cosine vector. This inverts the lexical
   order. Also define a throwing mock (`async () => { throw new Error("embed down") }`).
2. **[test] AC#1 semantic surfaces a note lexical drops:** seed a **paraphrase** note that shares NO
   ≥3-char non-stopword surface token with the query (so `overlapScore` → 0 → lexical omits it) + an
   **incidental** note that shares one token. (i) With NO embedder, assert lexical `recall(query)`
   returns **only** the incidental key (paraphrase omitted). (ii) Inject the mock via `setEmbedder`,
   assert semantic `recall(query)` returns the **paraphrase key first**. `finally`:
   `setEmbedder(undefined)` so no leak. (Drive via the recall tool or `/memory recall`.)
3. **[test] AC#2 default byte-identical + kill switch:** with no embedder, an existing recall assertion
   holds unchanged; with `EAGENT_MEMORY_EMBED=off` set AND the mock injected, ranking is the lexical
   order (restore the env var in `finally`).
4. **[test] AC#3 fail-soft = deep-equal lexical:** inject the throwing mock, `recall(query)`; assert the
   result **deep-equals** the no-embedder (lexical) recall for the same seed+query, and no exception
   propagates.
4b. **[test] real-embedder response parser (offline, no network):** unit-test the parser that turns an
   OpenAI-compatible `{ data: [{ embedding: number[] }, …] }` body into `number[][]` (export it or test
   via a stubbed `fetch`), so a shape typo is caught without a live endpoint. Assert order preservation
   and a malformed body → throws (→ caught by fail-soft at the call site).
5. **[impl] the embedder machinery** in `memory.ts` (module scope): `export type Embedder = (texts:
   string[]) => Promise<number[][]>;` a `let injected: Embedder | undefined = undefined;` (default
   **undefined**, NOT `resolveEmbedder()` — do all env resolution at call time), `export function
   setEmbedder(fn: Embedder | undefined): void { injected = fn; }` (mirrors self-improve.ts:245-250).
   An `activeEmbedder(): Embedder | undefined` computed **at call time**: if `EAGENT_MEMORY_EMBED ===
   "off"` → `undefined` (kill switch); else `injected ?? resolveEmbedder()`. `resolveEmbedder()`:
   `undefined` unless `process.env.EAGENT_MEMORY_EMBED_ENDPOINT` is set, else a `fetch`-based embedder
   POSTing `{ model, input: texts }` to the endpoint with an Authorization header from
   `EAGENT_MEMORY_EMBED_API_KEY ?? OPENAI_API_KEY`, a bounded `AbortSignal.timeout(10000)`, parsing
   `{ data: [{ embedding }] }` → `number[][]`. Call-time resolution keeps the kill switch + any injected
   mock + endpoint env all live per recall (a test/env change is honored).
6. **[impl] cosine + async `searchTiers`:** add `cosine(a, b): number` (dot / (‖a‖‖b‖); guard a zero
   norm → 0). Make `searchTiers` `async`. **CRITICAL — candidate enumeration:** the semantic branch
   MUST enumerate the candidate `{key, tier, text}` set from the **full** `noteKeys(store)` +
   `archiveKeys(store)` iteration — do **NOT** reuse the lexical `score > 0` filter to pick candidates,
   or a zero-lexical-overlap paraphrase would never become a candidate to embed and AC#1 fails. If an
   active embedder exists AND the kill switch is not `off`: `try { const vecs = await embedder([query,
   ...allCandidateTexts]); rank by cosine(queryVec, entryVec) desc; keep (optionally drop negative
   cosine); take topK } catch { <fall through to lexical> }`. Else / on catch: the **existing
   synchronous lexical** ranking (unchanged, which DOES apply the `score > 0` filter). Extract that
   lexical ranking into a `lexicalRank(store, query, topK)` helper so both the default and the catch
   call the SAME function → AC#3 deep-equal holds. Semantic hits populate `Match.score` with the
   **cosine float** (the lexical path stores an integer overlap count); `renderMatch` (`memory.ts:139`)
   prints it — an acceptable value change within the unchanged output *shape* (no existing test pins the
   score string; the AC-7 recall test asserts the key).
7. **[impl] await the callers:** the `recall` tool `execute` already `async` — `await searchTiers(...)`;
   the `/memory recall` command path runs through **`runScratchpad`** (`memory.ts:180`, currently
   `void`) — make `runScratchpad` (or at least its `recall` case) `async` and have the command's `run`
   return/await it (the dispatcher awaits `Command.run`, `cli.ts:259`). Preserve the same candidate
   enumeration (a key in both tiers → two hits). No output-shape change.
8. **[impl] relevance.ts docstring:** correct the one line asserting the zero-dep rule forbids vector
   embeddings (it is overturned — a `fetch` embedder is zero-dep). One-line edit; no code change there.

**Per-task acceptance commands:**
- `node --import tsx --test test/memory.test.ts` exit 0 (existing + 4 new).
- `npm run typecheck` exit 0.

**Exit condition:** the new tests pass (semantic-beats-lexical, default byte-identical, kill switch,
fail-soft deep-equal); existing memory tests green; `npm test` green; typecheck 0; eval 5/5;
`src/kernel/` untouched; no new dependency.

## 3. Engineering Constraints Index

- CLAUDE.md "House conventions": ESM `.js` import specifiers, strict TS (no `any`), zero runtime deps,
  offline `node:test`, an `EAGENT_<NAME>=off` kill switch when a default-loaded extension's behavior
  changes. **No Claude/AI attribution in commits.**
- Four-corner template: `~/.claude/skills/three-loop-workflow/references/loop-3-development.md`.
- Commit: `feat(phase1):`/`fix(phase1-roundR):`; `<TEST-CMD>`/`<ACCEPT-CMD>` trailers; no AI mention.
- Injection seam precedent: `self-improve.ts:245-250` (`setEvaluator`). Fetch-zero-dep precedent:
  `src/providers/openai.ts`.

## 4. Data and Fixture Dependencies

- **Reuse:** `test/memory.test.ts` `makeMemHarness`/`loadMem`/`runMemory`, the note-seeding via
  `h.store.set("note:<k>", entry)`, the recall tool exec pattern.
- **New:** the deterministic mock embedder + throwing mock (test-only). No new npm dependency; global
  `fetch`, `node:*` only.

## 5. Regression Protection

- **Must stay green:** all existing `test/memory.test.ts` (the lexical recall tests must be
  byte-identical with no embedder — pinned by AC#2), plus the `forget-archive` test added earlier; the
  full `npm test`; `npm run eval`. `src/kernel/` untouched (kernel-surface unaffected).
