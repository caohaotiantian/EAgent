# Light-Mode brief — memory resolveEmbedder wire test (TEST-1)

Status: closed
Closing-commit: (this commit)
Closed-on: 2026-07-02

**Slug:** `2026-07-02-memory-embedder-wire-test` · **Tier:** Light (`src/extensions/memory.ts` [add one
`export`] + `test/memory.test.ts`; test-focused, no behavior change, no new contract). Source:
`docs/DEFERRED-FOLLOWUPS.md` TEST-1. Branch: `chore/audit-gaps-2`.

## What / why

`memory`'s real `fetch` embedder `resolveEmbedder` (`memory.ts:148-165`) — env resolution of
`EAGENT_MEMORY_EMBED_ENDPOINT`/`_MODEL`/`_API_KEY` (falling back to `OPENAI_API_KEY`), the Bearer
header, the `{ model, input }` POST body, `AbortSignal.timeout(10000)`, the `if (!res.ok) throw`
branch, and `parseEmbeddings(await res.json())` — has **zero offline coverage**. Tests inject a
deterministic mock via `setEmbedder` and unit-test `parseEmbeddings`, but the production wire glue runs
in no test. Because the semantic tier is **fail-soft** (any embed error → lexical), a regression here
(env rename, header typo, timeout removal) produces **permanent silent lexical fallback** with no
failing test and no operator signal. It **is** cheaply offline-testable: `resolveEmbedder` reads the
global `fetch`, and the repo already stubs `globalThis.fetch` for this exact purpose
(`otel-exporter.test.ts`, `web.test.ts`).

**Change:** `export` `resolveEmbedder` (test-only export, matching the file's existing
`export function scanArgs`-style seams — `parseEmbeddings`/`setEmbedder` are already exported) and add a
`globalThis.fetch`-stub test over it.

## Explicit non-goals (Simplicity First)

- **No behavior change** — the only source edit is adding `export` to `resolveEmbedder`. No change to the
  embedder logic, the fail-soft path, the kill switch, or `activeEmbedder`.
- No embed-on-write caching, no real-endpoint smoke — out of scope (they stay deferred per RW7b-1).
- No new capability, dependency, or kernel change.

## Any >1-option decision surfaced

None. Exporting the private function for a direct unit test is the established repo pattern
(`scanArgs`, `maxSessions`, `sendJson`).

## Measurable acceptance command

- `node --import tsx --test test/memory.test.ts` exit 0 — NEW tests (each saving/restoring env +
  `globalThis.fetch` in `finally`): with `EAGENT_MEMORY_EMBED_ENDPOINT`/`_MODEL`/`_API_KEY` set and a
  capturing `fetch` stub, the embedder returned by `resolveEmbedder()` (a) POSTs to the endpoint with
  `content-type: application/json`, `authorization: Bearer <key>`, and body `{ model, input: texts }`;
  (b) returns the vectors parsed from an OpenAI-shaped `{ data: [{ embedding: […] }] }` response;
  (c) **throws** on a non-ok response (`res.ok === false`); and (d) `resolveEmbedder()` returns
  `undefined` when `EAGENT_MEMORY_EMBED_ENDPOINT` is unset. A control: `_API_KEY` unset ⇒ no
  `authorization` header (falls back to `OPENAI_API_KEY`, then none).
- `npm test` exit 0 · `npm run typecheck` exit 0 · `npm run eval` exit 0 · `src/kernel/` untouched · no
  new dependency.

## Closure

**Closed** 2026-07-02. `resolveEmbedder` is exported (test seam; body unchanged) and covered by a
`globalThis.fetch`-stub test asserting the real wire — endpoint, `POST`, `content-type`,
`authorization: Bearer <key>`, body `{model, input}`, the `{data:[{embedding}]}` parse, the `!res.ok`
throw, and unset→undefined / no-key→no-auth-header. Mutation-verified (body `input`→`texts` fails the
assertion). A regression here previously produced silent permanent lexical fallback with no failing
test; now it's caught. Light-Mode fresh review **pass** (clean first round; assertions genuine/non-
tautological — the `/500/` reject distinguishes the fail-soft throw from a parse error; env+fetch
save/restore, no cross-test contamination). Gates: memory 34 pass, `npm test` 1189 pass / 0 fail / 1
skip, typecheck 0, eval 5/5, `src/kernel/` untouched, no new dependency.
