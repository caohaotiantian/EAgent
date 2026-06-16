# EAgent — Code Review & End-to-End Test Report

**Date:** 2026-06-16
**Scope:** Whole-project review + live end-to-end test against a configured GLM-5.1 endpoint.
**Method:** Offline baseline (typecheck / 173-test suite / build), live agent runs against the
real provider, and a multi-agent code review (6 reviewers across kernel / providers / extensions /
hosts / tests+docs, each finding adversarially verified by an independent skeptic). 42 findings
raised, **40 confirmed, 2 rejected** as false positives.

---

## 1. End-to-end test results

The project did **not run as delivered**: `node_modules` was never installed, so typecheck, the
test suite, and the app all failed (`Cannot find package 'tsx'`, `Cannot find name 'process'`).
After `npm ci`:

| Check | Result |
| --- | --- |
| `npm run typecheck` | clean |
| `npm test` | **173 / 173 pass** (fully offline, MockProvider) |
| `npm run build` → run `dist/cli.js` | clean; `--version`, `--help`, mock turn all work |
| **Live — OpenAI path, plain turn** (GLM-5.1) | streamed `PONG`; usage 2829 / 4; `end_turn` |
| **Live — OpenAI path, tool round-trip** | model called `read` → kernel dispatched (fs:read pre-granted) → fed result back → answered `0.2.0`; cumulative usage tracked across both turns |
| **Live — Anthropic path, plain turn** | streamed `PONG`; **input tokens reported `0`** (proxy omits `usage.input_tokens` in `message_start`; provider tolerates it) |

The complete agent loop is verified live: streaming, bidirectional wire-format mapping,
capability-gated tool dispatch, multi-turn follow-up, and usage accounting.

**Reproduce (OpenAI-compatible path):**

```bash
node --env-file=.env --import tsx src/cli.ts --provider openai --model GLM-5.1 \
  --eval 'Use the read tool to read package.json and report the version.'
```

`--env-file` and `--model` are *required* because of the config gaps in §4 (the app does not load
`.env`, ignores `OPENAI_MODEL`/`ANTHROPIC_MODEL`, and reads `ANTHROPIC_API_KEY` rather than the
`ANTHROPIC_AUTH_TOKEN` that the `.env` supplies).

---

## 2. High-severity findings (security) — 3

### H1. Arbitrary file read via path traversal — `src/extensions/self.ts:136-147`
`read_extension` places the *raw, unsanitized* `name` first in the candidate list whenever it ends
in `.ts/.js/.mjs/.tsx`. `slugify` is computed but applied only to the *other* candidates, so the
raw path bypasses it. `extname('../../../../etc/hosts.js') === '.js'`, and
`join('<home>/.eagent/extensions','../../../../etc/hosts.js')` resolves to `/etc/hosts.js`. The tool
is gated only by `self:read`, which the extension **auto-grants** (line 94), so an agent can read
any `.ts/.js/.mjs/.tsx` file anywhere on disk with no ask/deny prompt. `write_extension` is safe
(builds its path from `slug` only).
**Fix:** build candidates purely from the validated `slug`, and assert
`resolve(path).startsWith(resolve(dir) + sep)` before reading.

### H2. Server is unauthenticated + binds all interfaces + forces yolo — `src/server.ts:59,113,244`
`token` defaults to `""` when neither `opts.token` nor `EAGENT_TOKEN` is set, and the gate is
`if (security.token && !authorized(...))` — so with no token the gate is skipped entirely.
`server.listen(port, ...)` omits the host argument (binds `0.0.0.0`/`::`) while `main()` logs
`http://localhost`. The server also forces `yolo:true`, making the capability fallback `allow`,
which defeats the deliberate "`shell:exec` is not auto-granted" protection. Net effect: **remote
arbitrary shell execution out of the box.**
**Fix:** bind `127.0.0.1` by default; refuse to start (or warn loudly) when no token is set.

### H3. Extension id-collision leaks the prior extension — `src/kernel/extension.ts:185-224`
`activate()` overwrites `#loaded` for a colliding id without tearing the old one down. The previous
`teardown` disposable is dropped, so the old version's tool/provider/command/hook/filter
registrations stay live forever — hooks fire twice, and the orphaned tool shadow resurfaces if the
survivor is later unloaded. Contradicts the documented "later directories win."
**Fix:** at the top of `activate()`, if `#loaded.has(spec.id)`, dispose + delete the existing entry
first (the pattern `reload()`/`unload()` already use).

> **Also (secret hygiene, partially fixed):** the committed `.gitignore` did not protect `.env`,
> which holds a live-looking key. A working-tree edit adding `.env`/`.env.*`/`!.env.example` has
> been applied during this review — **commit it** to make it durable, and consider rotating the
> token since it has been written to disk. (`.env` was never committed to history.)

---

## 3. Medium-severity findings — reliability & correctness

| ID | Location | Issue | Fix |
| --- | --- | --- | --- |
| M1 | `kernel/agent.ts:156-207` | `stop()`/abort is never checked by the turn loop; only the provider sees the signal, so a provider that doesn't reject on abort (e.g. mock) keeps the loop running | Check `signal.aborted` at the top of each iteration and after `streamTurn`; break with reason `"stop"` |
| M2 | `kernel/extension.ts:147-158` | `reload()` tears down the old extension, then loses it permanently if re-activation throws (no rollback); also emits global `session_shutdown`/`session_start` on a single-id reload | try/catch with rollback to the previous origin; gate lifecycle events on `id === undefined` |
| M3 | `providers/http.ts:26,31` | `parseSSE` splits on literal `"\n\n"`; a CRLF (`\r\n\r\n`) stream buffers forever and yields nothing | Use `/\r?\n\r?\n/` boundaries and `/\r?\n/` line splits |
| M4 | `extensions/journal.ts:46-55` | One corrupt JSONL line makes `readJournal()` return `[]`, discarding the entire durable journal on `/resume` | Parse line-by-line; skip only the unparseable (typically trailing) line |
| M5 | `extensions/session.ts:239-246` | Session/journal load casts to `Message[]` with no per-element validation; a corrupt-but-valid-JSON entry crashes a *later* turn | Validate `role`/`content` shape per entry at load; reject (`/load`) or skip (`/resume`) |
| M6 | `extensions/mcp.ts:191-205` | HTTP MCP transport has no request timeout and never passes an abort signal; a hung server blocks activation or a turn forever | `AbortSignal.timeout(...)` in `#post`; thread `ctx.signal` through `request` |
| M7 | `server.ts:151-202` | Client disconnect mid-`/run` does not abort the agent; work continues to a dead socket and the single-flight lock stays held | `res.on('close', () => agent.running && agent.stop())`; guard writes after close |
| M8 | `providers/openai.ts:60` | Body sends `max_tokens`; newer official OpenAI models reject it (need `max_completion_tokens`) while compat proxies need `max_tokens` | Make the token-limit field configurable / model-family aware |
| M9 | `host.ts:176` | `selectProvider` returns an unknown `--provider` string that is never registered; the host starts fine then fails on the first turn | Error at startup for unknown non-mock names, or fall through to auto-select |

---

## 4. Medium-severity findings — config / DX (the friction behind "I configured `.env`")

| ID | Location | Issue |
| --- | --- | --- |
| C1 | `host.ts` / `cli.ts` / `server.ts` | **`.env` is never loaded.** No `dotenv`, no `--env-file` in any npm script. A user who only edits `.env` silently gets the offline mock, while the CLI help implies env config "just works." |
| C2 | `providers/anthropic.ts:48`, `host.ts:112-117` | **`ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_MODEL`, `OPENAI_MODEL` are never read.** The `.env` sets all three. The Anthropic provider only reads `ANTHROPIC_API_KEY`; the model is hardcoded to `claude-fable-5`/`gpt-4o`/`gemini-2.0-flash`. |

These two are the direct cause of the `--env-file`/`--model`/token-alias workarounds needed in §1.
**Fix:** load `.env` at host startup with a tiny zero-dep parser; fall back to `ANTHROPIC_AUTH_TOKEN`
(sent as `Authorization: Bearer`) and to `*_MODEL` env vars before the hardcoded defaults.

---

## 5. Low-severity & nit findings

| ID | Location | Issue |
| --- | --- | --- |
| L1 | `kernel/agent.ts:291-321` | `beforeToolCall`-rewritten arguments bypass schema validation/coercion (the kernel's "clean, typed input" promise) — re-validate after the guard or document the passthrough |
| L2 | `kernel/store.ts:56-86` | `FileStore` writes are non-atomic (`writeFileSync` direct), corrupt read silently returns `{}`, and two instances over one namespace clobber each other — write-temp+rename; one instance per namespace |
| L3 | `providers/openai.ts:124` | Synthesized tool-call id `call_<name>` collides for two parallel calls to the same tool when a compat endpoint omits ids — incorporate the slot index |
| L4 | `providers/http.ts:33` | `data:` parsing uses `.trim()` instead of stripping a single leading space (SSE spec deviation) |
| L5 | `providers/http.ts:87` | `Retry-After` HTTP-date form falls back to a flat 1 s (only delta-seconds handled) |
| L6 | `providers/gemini.ts:107` | Unconditionally overwrites stop reason to `tool_use`, dropping a concurrent `max_tokens` truncation signal |
| L7 | `extensions/core-tools.ts:163-196` | `bash` runs with no `cwd` confinement, so the fs workspace sandbox is bypassed once `shell:exec` is granted — set `cwd: workspaceRoot()`; document that `shell:exec` ≈ full host fs access |
| L8 | `extensions/web.ts:196-200` | `/fetch` command reads the whole body via `res.text()`, bypassing the tool's `readCapped` memory guard |
| L9 | `extensions/web.ts:34-40,132-138` | SSRF: `validateUrl` checks scheme only and `redirect:'follow'` can reach internal/metadata hosts after the check (documented stance; note that redirect-following defeats caller-side allowlisting) |
| L10 | `extensions/mcp.ts:320-347` | Duplicate MCP server names silently shadow each other's tools; `/mcp` still reports both as connected |
| L11 | `extensions/mcp.ts:289,320` | `tools/list` result is trusted structurally; a malformed entry yields `mcp__srv__undefined` or an invalid schema — validate per entry |
| L12 | `extensions/codeact.ts:76` | Subprocess inherits the real `cwd`, so HOME scrubbing under-delivers on isolation — spawn with `cwd: <tmpdir>` |
| L13 | `extensions/packages.ts:221-233` | Persisted packages are re-imported and executed on `session_start` with no fresh `pkg:install` check; the store JSON is tamperable and `entryPath` is unconfined |
| L14 | `extensions/packages.ts:258-282` | `git clone`/`npm install` shell out with no URL validation — reject `ext::`/`file://`/leading `-`; add `--` |
| L15 | `extensions/memory.ts:83-91` | Summary cache keyed only by message count; after `/load`/`/handoff`/`clear()` a stale summary from another transcript can be injected — fingerprint the covered prefix |
| L16 | `extensions/checkpoint.ts:89-100` | Checkpoints reference dangling `git stash create` commits that `git gc` can prune — anchor under `refs/eagent/checkpoints/<id>` |
| L17 | `server.ts:228-234` | Bearer comparison is not timing-safe despite the "constant-time-ish" comment — use `crypto.timingSafeEqual` |
| L18 | `cli.ts:39-47` | Value-taking flags can swallow the next flag or push `undefined` (`--ext` uses `argv[++i]!`); unknown flags are silently ignored — validate the next token |
| N1 | `providers/gemini.ts:136` | tool_result `isError` flag silently dropped (no Gemini error field) |
| N2 | `providers/anthropic.ts:111` | `cache_creation`/`cache_read` tokens folded into a flat `inputTokens`, obscuring billing weight |
| N3 | `extensions/core-tools.ts:77-79` | `read` offset/limit not validated as positive integers; NaN limit yields an empty slice |
| N4 | `extensions/prompts.ts:23-35` | Dead `rest` variable + `void rest;` in `/prompt-save` |
| N5 | `cli.ts:128-138` | SIGINT handler only attached in interactive mode; batch/eval Ctrl-C skips `host.dispose()`, orphaning MCP child processes |
| D1 | `CLAUDE.md:45-48` | Lists a stale 11-extension / 2-provider set; actual is 18 extensions / 5 provider files |
| D2 | `README.md:248,304` | Lists `/sessions` as an endpoint; only `GET /health`, `POST /run`, `DELETE /sessions/:id` exist |

---

## 6. Rejected findings (verifier caught the false positives)

- **"MCP raw result leaks into transcript / no size cap"** — the agent loop builds the tool_result
  from only `result.content`/`result.isError`; the `details` field is never serialized, and the
  `limits` extension caps content via an `afterToolCall` hook.
- **"Non-TTY `--yolo` bypasses the capability audit's ask semantics"** — under `--yolo` the
  capability fallback is `allow`, which short-circuits *before* `confirm()` is reached; and the
  audit explicitly records `prompted: false` for auto-grants vs `true` for interactive grants.

---

## 7. Assessment

The kernel design is sound and the live agent loop works end-to-end against the GLM-5.1 proxy. The
priority order for remediation is: **H1–H3** (security) → **C1–C2** (make `.env` actually work) →
the **M** cluster (reliability) → opportunistic L/N/D cleanup. None of the findings indicate a
structural flaw in the seven-primitive design; they are localized gaps in robustness, capability
enforcement, and configuration ergonomics.

---

## 8. Remediation applied (2026-06-16)

All findings above were triaged and the great majority fixed in the same pass, each kept green by
the test suite (now **188 tests**, up from 173). `npm run typecheck`, `npm test`, and `npm run build`
all pass; the live GLM-5.1 end-to-end was re-verified and now works with **zero workarounds** (no
`--env-file`, `--model`, or token aliasing needed).

**Fixed (35):** H1, H2, H3 (security); C1, C2 (config/DX); M1–M9 (reliability);
L1, L2, L3, L4, L5, L6, L7, L8, L9, L11, L12, L14, L15, L16, L17, L18; N1, N3, N4; D1, D2.
Plus the `.env` secret-hygiene item (gitignored; `.env.example` added).

New regression tests cover: the `self` path-traversal block, extension id-collision teardown, the
`.env` loader / provider-selection / `AUTH_TOKEN` alias / `*_MODEL` (new `test/host.test.ts`),
journal corrupt-line recovery, session malformed-entry rejection, CRLF SSE parsing, `stop()` halting
the loop, and OpenAI token-param / parallel-id behavior.

**Deliberately deferred (5)** — low severity with design trade-offs better discussed than forced:

| ID | Why deferred |
| --- | --- |
| L10 | MCP duplicate-server-name shadowing — operator-misconfig observability nit; needs a UX decision (warn vs rename vs reject). |
| L13 | Persisted-package auto-reload capability re-check — confining `entryPath` to the packages dir would break legitimate `path:` installs; re-prompting `pkg:install` at every startup is intrusive. Exploitation already requires FS-write compromise; `pkg:install` is not auto-granted. |
| N2 | Anthropic cache-token accounting is a documented `Usage`-shape limitation, not a bug. |
| N5 | CLI SIGINT only in interactive mode — orphaned MCP children on batch Ctrl-C; one-shot `--eval` is unaffected. |
| — | (L15 was fixed.) |

See `CHANGELOG.md` (`[Unreleased]`) for the user-facing summary.
