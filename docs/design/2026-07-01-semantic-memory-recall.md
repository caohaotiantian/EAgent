# Design — optional semantic (embedding) memory recall (RW7b-1)

**Slug:** `2026-07-01-semantic-memory-recall` · **Tier:** Full (new config surface + an injectable
provider abstraction + a >1-option ranking decision; a user-facing recall-quality change). Source:
`docs/DEFERRED-FOLLOWUPS.md` RW7b-1. Branch: `chore/finish-followups-3`.

## 1. Background and Purpose

`memory` recall ranks core + archive notes by **lexical** token overlap (`searchTiers` →
`overlapScore`, `memory.ts:120-136`). Lexical overlap misses paraphrase ("what's the DB password" vs a
note "postgres credential is …"). RW7b-1 is the deferred **semantic** tier: rank by embedding cosine
similarity when an embedding provider is configured.

The register deferred this as "forbidden by the zero-dep rule (needs a network embed-provider)." That
premise is **incorrect** and this design corrects it: the chat providers already do zero-dep `fetch`
+ SSE (`src/providers/*.ts`, no SDK), so a `fetch`-based embedder is equally zero-dep, and the offline
test posture is preserved by an **injectable deterministic mock** (the established `self-improve`
`setEvaluator` pattern). So semantic recall is feasible within the constraints — as an **opt-in**,
off-by-default enhancement that degrades to today's lexical ranking whenever no embedder is configured
or an embed call fails.

If we do not add it: recall stays purely lexical, missing semantically-related notes on any query that
doesn't share surface tokens.

## 2. Deliverables

- [ ] An `Embedder` type in `memory.ts`: `(texts: string[]) => Promise<number[][]>` (batch text →
  unit-comparable vectors). No kernel change; lives in the extension.
- [ ] `setEmbedder(fn: Embedder | undefined)` test hook (module-level, mirrors
  `self-improve.ts`'s `setEvaluator`) so offline tests inject a deterministic mock; production resolves
  a `fetch`-based embedder from env config, or `undefined` when unconfigured.
- [ ] A `fetch`-based real embedder (zero-dep) POSTing to an OpenAI-compatible `/v1/embeddings`
  endpoint, gated on `EAGENT_MEMORY_EMBED_ENDPOINT` (+ `EAGENT_MEMORY_EMBED_MODEL`, and an API key env);
  **inert (embedder `undefined`) when the endpoint is unset**.
- [ ] `searchTiers` gains an **async semantic path**: when an embedder is active, embed the query + the
  candidate entry texts in one batch and rank by cosine similarity; **fail-soft** — any embed error (or
  no embedder) falls back to the existing synchronous lexical ranking, byte-identical to today.
- [ ] The recall tool (`execute` already `async`) and the `/memory recall` command await the (now
  async) ranking; the command path runs through `runScratchpad` (`memory.ts:180`, currently
  `void`-returning), so its `recall` case + the command's `run` thread the promise through — the
  dispatcher already awaits (`Command.run` returns `void | Promise<void>`, `cli.ts:259`). Output shape
  unchanged; the same candidate enumeration is preserved, so a key present in **both** tiers still
  yields two independent hits (`memory.ts:117-118`).
- [ ] `EAGENT_MEMORY_EMBED=off` kill switch (forces lexical even if an endpoint is configured), per the
  house convention, since this changes a default-loaded extension's behavior when configured.
- [ ] Offline tests: with an injected mock embedder, recall ranks a paraphrase hit above a
  lexical-only hit; with no embedder, recall is byte-identical to the current lexical behavior; an
  embedder that throws falls back to a result **deep-equal to the lexical ranking** (fail-soft); the
  kill switch forces lexical.
- [ ] Correct the now-stale docstring in `src/extensions/lib/relevance.ts` ("The zero-runtime-dependency
  rule forbids vector embeddings") — it is overturned by this design (a `fetch` embedder is zero-dep).

## 3. Scope Boundary (NOT in scope)

- **No stored/cached vectors, no `remember`-time embedding, no Entry-shape change, no migration.**
  Embeddings are computed **on recall** (query + candidates, batched). Vector caching / embed-on-write
  is a documented follow-up (an optimization for large note sets; the tiers are cap-bounded today).
- **No kernel change** (`src/kernel/` untouched — respects the 0-line headroom). No new `Provider`
  registry entry; the embedder is memory-extension-local.
- **No hybrid lexical+semantic score fusion.** When an embedder is active, ranking is **cosine-only**;
  when absent/failed, **lexical-only**. A tuned hybrid is a follow-up.
- **No new npm dependency** (global `fetch`, `node:*` only). No change to the `remember` tool,
  `edit`/`forget`/`rollback`/`consolidate`/`archive`/`promote`/`forget-archive`, eviction, or the
  lexical `overlapScore` itself.
- **Quality budget:** recall correctness (the semantic-ranks-paraphrase-above-lexical assertion) +
  fail-soft (never break recall) + `npm test`/`typecheck`/`eval` exit 0. No latency budget (a network
  recall is opt-in and operator-accepted); the lexical default path is unchanged.

## 4. Key Design Decisions

### D1 — embed-on-recall (not embed-on-write) for v1

- **Problem:** where to compute embeddings — per recall, or once at write time (cached)?
- **Options:** (1) **embed-on-recall**: embed query + all candidate texts each recall (chosen); (2)
  embed-on-write: embed each note at `remember`, store the vector in the Entry, embed only the query at
  recall; (3) lazy embed-on-first-recall + cache.
- **Choice: (1).** It is the smallest, correctness-first slice: no Entry-shape change, no stored-vector
  migration for existing notes, no async `remember` (which would make writing a note block on the
  network). The tiers are cap-bounded (`coreCap` 64 + `archiveCap` 512 = **up to ~576 candidate texts**
  per recall, `memory.ts:27-29`), so the per-recall cost is bounded. **Single-request-batch assumption:**
  v1 embeds the query + candidates in **one** `/v1/embeddings` request; OpenAI proper allows 2048
  inputs, but an OpenAI-*compatible* proxy could cap lower — if the request 400s/times out, fail-soft
  (D2) degrades to lexical, so it never breaks recall. **Request chunking is an explicit non-goal for
  v1** (it belongs with the embed-on-write caching follow-up). (2)/(3) are the efficiency win but add
  stored vectors + a migration + async `remember` + a "note written before the embedder existed" gap —
  a larger design, deferred as the documented follow-up. Recall is already the read path; making it
  async is contained.
- **Rejected:** (2) premature optimization with migration/async-write cost; (3) same, plus cache
  invalidation on `edit`.

### D2 — an injectable `Embedder` function, off by default, fail-soft

- **Problem:** how to make a network provider offline-testable and non-default.
- **Options:** (a) an injectable `Embedder` function + a `fetch`-based default resolved from env, with a
  `setEmbedder` test hook (chosen); (b) a new kernel `EmbedProviderRegistry`; (c) always-lexical (don't
  build).
- **Choice: (a).** Mirrors the proven `self-improve` `setEvaluator` seam: production resolves a real
  `fetch` embedder **only** when `EAGENT_MEMORY_EMBED_ENDPOINT` is set (else `undefined` ⇒ lexical);
  tests inject a deterministic mock. **Fail-soft**: `searchTiers` wraps the embed call in try/catch and
  falls back to lexical on any throw/timeout, so a down embedding endpoint never breaks recall (matching
  the otel/mcp best-effort posture). Zero kernel change (no registry). `EAGENT_MEMORY_EMBED=off`
  force-disables even when configured.
- **Rejected:** (b) a kernel registry spends the 0-line headroom + over-generalizes for one consumer;
  (c) forgoes the feature the user asked to finish.

### D3 — cosine similarity; cosine-only when active, lexical-only otherwise

- **Problem:** how to score with vectors, and whether to blend with lexical.
- **Choice:** **cosine similarity** over the L2-normalized vectors (standard for text embeddings); sort
  descending, take `topK`. When an embedder is active, rank **cosine-only** (semantic intent dominates);
  when absent/failed, **lexical-only** (today). A blended hybrid needs weight tuning (a threshold
  decision) and is deferred. **Bounding is `topK`, not a score floor:** real text embeddings occupy a
  narrow cone (pairwise cosine is almost always > 0), so a ">0" floor would drop nearly nothing in
  production — `topK` does the actual bounding. (For parity with the lexical path's ">0" filter and to
  keep the mock deterministic, a *negative*-cosine drop is fine, but the load-bearing bound is `topK`.)
- **Rationale:** cosine is the conventional, magnitude-invariant text-embedding metric; the mock
  embedder in tests produces deterministic vectors so the ranking assertion is stable. Rejected:
  Euclidean (magnitude-sensitive), dot-product-without-normalization (length bias).

### D4 — config surface + the mock embedder

- **Env:** `EAGENT_MEMORY_EMBED_ENDPOINT` (the `/v1/embeddings` URL; unset ⇒ inert),
  `EAGENT_MEMORY_EMBED_MODEL` (default a sensible model id string), the API key
  (`EAGENT_MEMORY_EMBED_API_KEY`, falling back to `OPENAI_API_KEY` **only** — an operator pointing the
  endpoint at a non-OpenAI proxy should set the scoped key so the OpenAI key isn't forwarded to a third
  party), and `EAGENT_MEMORY_EMBED=off` (kill switch). A fixed **10s** `AbortSignal.timeout` on the
  fetch (not store-overridable in v1); on timeout/error → fail-soft to lexical (D2). Mirrors the
  provider env conventions.
- **Mock (tests only):** a deterministic bag-of-words / hashed-token vector embedder injected via
  `setEmbedder`, constructed so a paraphrase note and the query share vector mass while a
  lexical-only-overlapping note does not — making the semantic-beats-lexical assertion deterministic.

## 5. Dependencies and Assumptions

- Global `fetch` (already used by every provider), `node:*` only. No new dependency, no kernel change.
- Assumes the `self-improve` `setEvaluator` module-hook pattern is the sanctioned way to inject a
  network dependency for offline tests (it is — `self-improve.ts` + its tests).
- Assumes memory tiers are cap-bounded so embed-on-recall over all candidates is acceptable for v1.
- Assumes an OpenAI-compatible `/v1/embeddings` response shape (`{ data: [{ embedding: number[] }] }`)
  for the real embedder; the mock bypasses the wire.

## 6. Relationship with Existing Designs

- **`docs/design/2026-06-29-tiered-memory.md`** (the core/archive tiers + lexical `overlapScore` recall)
  — this is its registered follow-up RW7b-1. Strictly additive: `searchTiers` keeps the lexical path
  verbatim as the default/fallback; the semantic path is an opt-in branch. `overlapScore`
  (`lib/relevance.ts`) is untouched.
- **`self-improve.ts`** — reuses its `setEvaluator`-style injectable-network-dependency pattern for
  offline testability (`setEmbedder`).
- **The `fetch`-based providers** (`src/providers/*.ts`) — the zero-dep-network precedent the real
  embedder follows; this corrects the register's "zero-dep forbids it" premise.
- No kernel change; no conflict with the 2199/2200 ceiling.

## 7. Acceptance Criteria (measurable / automatable)

1. **Semantic surfaces a note lexical drops (mock):** with an injected deterministic mock embedder,
   `recall(query)` returns as its **top hit** a paraphrase note that shares **no** ≥3-char non-stopword
   surface token with the query (so the lexical `overlapScore` path scores it **0** and **omits** it
   entirely — the lexical recall for the same seed returns only the incidental-token note). The
   semantic path both surfaces the paraphrase AND ranks it first. PASS = test asserts (a) lexical
   recall omits the paraphrase key, (b) semantic recall returns the paraphrase key first. (This is a
   stronger, non-tautological discriminator than an order-swap: it proves the cosine path is wired in
   and finds a note lexical cannot — while honestly validating *plumbing + cosine ranking*, not
   embedding quality, per §8 Risk 3.)
2. **Default byte-identical:** with no embedder configured (and no injection), `recall` returns exactly
   the current lexical ranking (an existing memory recall test still passes unchanged); with
   `EAGENT_MEMORY_EMBED=off` set, ranking is lexical even if an endpoint is configured.
3. **Fail-soft = identical to lexical:** an injected embedder that throws (or rejects) causes `recall`
   to fall back and return a result **byte-identical to the lexical ranking** for the same query — the
   catch must re-run the full synchronous `overlapScore` path, not a partial/empty result — and no
   exception surfaces to the tool/command. PASS = test asserts the thrown-embedder result deep-equals
   the no-embedder (lexical) result.
4. **No regression / no surface change:** `npm test` exit 0 (existing memory tests + new), `npm run
   typecheck` exit 0, `npm run eval` exit 0, `src/kernel/` untouched, no new dependency, no change to
   the recall output shape.

## 8. Risks and Rollback

- **Risk:** making `searchTiers`/recall async breaks a synchronous caller. **Mitigation:** only the
  recall tool (`execute` already `async`) and the `/memory recall` command reach it; the command's
  `recall` case in `runScratchpad` (`memory.ts:180`) + the command `run` become async and thread the
  promise, which the dispatcher already awaits (`cli.ts:259`, `Command.run: void|Promise<void>`). All
  other `/memory` verbs keep the synchronous lexical helpers untouched. **Rollback:** revert
  `searchTiers` (and `runScratchpad`'s recall case) to synchronous.
- **Risk:** a down/slow embedding endpoint stalls or breaks recall. **Mitigation:** fail-soft try/catch
  → lexical fallback + a bounded `AbortSignal.timeout` on the fetch (like otel's 5s). **Rollback:**
  `EAGENT_MEMORY_EMBED=off` or unset the endpoint (inert).
- **Risk:** the mock-vs-real ranking diverges (a test passes but real embeddings rank differently).
  **Mitigation:** the mock validates the *plumbing + cosine ranking*, not model quality; the real
  wire-shape is unit-checkable separately (a follow-up smoke). Documented.
- **Overall rollback:** one extension diff; unset the endpoint ⇒ inert (lexical), byte-identical to
  today.
