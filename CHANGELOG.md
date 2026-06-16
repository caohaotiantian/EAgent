# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Security

- **`self.read_extension` path traversal fixed.** It built file candidates from
  the raw, unsanitized name when it ended in a known suffix, so a name like
  `../../../../etc/hosts.js` escaped the extensions directory (arbitrary file
  read under the auto-granted `self:read`). Candidates are now built only from
  the sanitized slug, with a path-containment assertion.
- **HTTP server hardened.** `eagent-serve` now binds `127.0.0.1` by default
  (override with `EAGENT_HOST`), warns loudly when started without `EAGENT_TOKEN`
  (mutating routes are then unauthenticated and run tools with full
  capabilities), and the bearer-token check is constant-time
  (`crypto.timingSafeEqual` over fixed-length digests).
- **Extension id collisions no longer leak.** A second activation under the same
  id (the discover "later wins" path) now tears the previous version down first,
  so its tools/hooks are removed rather than left firing as orphans.

### Added

- **`flow-guard` extension — compositional capability policy.** Per-tool gating
  authorizes each call in isolation, but composing individually-safe tools can
  exfiltrate (read a secret, then POST it out). `flow-guard` rides the existing
  `tool_end` + `beforeToolCall` hooks to hold a network-egress call (`net:fetch`)
  once a sensitive source (`shell:exec`) has run this session — `ask` by default,
  `block`-able, tunable via `/flow-guard` or `EAGENT_FLOW_GUARD=off`. A new
  security best practice absorbed as a hot-reloadable extension, no core change.
  (Motivated by the 2026-06-16 design research; see `docs/RESEARCH-agent-kernel-design.md`.)
  It also enforces **data confinement**: the session is tainted by sensitive-path
  reads (`.env`, `id_rsa`, `.pem`, `.ssh/`, `.aws/`, `credentials`, `secret`) and
  credential-looking results (PEM keys, `AKIA…`, `sk-…`, `ghp_…`), not only by
  `shell:exec`.
- **MCP tool-integrity hardening.** Duplicate MCP server names are skipped (a
  later server can't silently shadow an earlier one's namespaced tools); a tool
  name that shadows an existing tool warns; and tool **descriptions are scanned
  for tool-poisoning / hidden-instruction patterns** at registration (the
  SSH-key-exfil attack class) — warned, never silently trusted.
- **`.env` auto-loading.** The CLI and server load a local `.env` at startup via
  a tiny zero-dependency parser (`loadEnvFile` in `host.ts`); real environment
  variables always win. A documented `.env.example` ships with the repo, and
  `.env`/`.env.*` are gitignored.
- **Model from environment.** `ANTHROPIC_MODEL` / `OPENAI_MODEL` / `GEMINI_MODEL`
  now set the default model per provider, so `--model` isn't needed on every run.
- **`ANTHROPIC_AUTH_TOKEN`** is accepted as an alias for `ANTHROPIC_API_KEY`
  (the gateway/Claude-Code convention).
- **`OPENAI_MAX_TOKENS_PARAM`** (and the `maxTokensParam` option) selects
  `max_tokens` vs `max_completion_tokens`, so newer official OpenAI models and
  OpenAI-compatible proxies are both reachable.

### Changed / Fixed

- **`stop()` is now honored by the agent loop** directly, not just forwarded to
  the provider, so an abort reliably halts the run.
- **Durable journal `/resume` recovers** from a single corrupt/truncated line
  instead of discarding the whole journal; session/journal loads validate each
  entry's shape at the boundary.
- **SSE parser tolerates CRLF** line endings (no more stall) and strips only a
  single leading space from `data:` per spec; `Retry-After` HTTP-date form is
  honored.
- **MCP HTTP transport** now has a request timeout and threads the agent's abort
  signal, so a hung server can't block activation or a turn.
- **Server aborts the agent on client disconnect** (frees the single-flight
  lock and stops wasting tokens).
- **Unknown `--provider` fails fast** at startup with a clear message instead of
  on the first turn.
- **`FileStore` writes are atomic** (temp file + rename) and a backend caches one
  store per namespace to avoid clobbering.
- Smaller fixes: OpenAI synthesizes unique ids for parallel same-name tool calls;
  Gemini preserves a `max_tokens` truncation signal and surfaces tool-result
  errors; `bash` defaults its cwd to the workspace; `/fetch` honors the size cap;
  `read` validates `offset`/`limit`; CLI rejects missing flag values and unknown
  options. Docs (`CLAUDE.md`, `README.md`) corrected to the real provider/
  extension/route set.

## [0.2.0] - 2026-06-15

A large capability release: two more real providers, multimodality, four front
ends, self-authoring extensions, durability, and production hardening — all
while the kernel stayed minimal (a guard test enforces it).

### Added

- **Providers:** OpenAI and Google **Gemini** providers (`fetch`+SSE, no SDK),
  joining Anthropic and the mock; shared retry/backoff/SSE/usage plumbing in
  `providers/http.ts`. Anthropic prompt caching with cache-token accounting.
  Record/replay **cassettes** (`RecordingProvider`/`ReplayProvider`) for
  deterministic offline testing of real-model behavior.
- **Multimodality:** an `image` content block (base64 or URL) with an
  `imageMessage` helper, mapped to each provider's format.
- **Front ends:** an HTTP server (`eagent-serve`) with `/health`, streaming
  `POST /run`, multi-turn `session` continuity, `DELETE /sessions/:id`, a
  concurrency lock, graceful shutdown, optional bearer-token auth
  (`EAGENT_TOKEN`), and a request-body cap. CLI `--json`, `--help`, `--version`,
  and token streaming.
- **Extensions:** `mcp` HTTP transport; `subagents`, `memory`, `planmode`,
  `session`, `packages`, `trace`, `context-files`, `limits` (output truncation +
  tool-call & token budgets), `self` (the agent authors/hot-loads its own
  TypeScript), `web` (capability-gated HTTP), `checkpoint` (git rollback),
  `introspect` (self-documentation), `journal` (durable runs + `/resume`), and
  `prompts` (saved templates).
- **API:** `ExtensionAPI.loadExtension`/`unloadExtension` for first-class
  dynamic/self-authored extensions; `defineTool<TArgs>` typing.
- **Tooling & docs:** GitHub Actions CI, `Dockerfile`, `ARCHITECTURE.md`,
  `docs/EXTENSIONS.md`, `CONTRIBUTING.md`, `SECURITY.md`, worked examples, a
  kernel-minimalism guard test, and `npm run test:coverage`.

### Changed

- The shared `createAgentHost` wiring (`src/host.ts`) backs every front end, so
  the built-in extension list has one home.
- The agent emits a `message` event for the user's message too, so every
  transcript message is observed uniformly.
- Filesystem tools are confined to a workspace root; token usage is accounted
  and surfaced via a `usage` event.
- Hardening: failed activations roll back partial registrations, a failing
  built-in is skipped at startup, and resilience is covered by tests
  (provider errors mid-stream, no-`done` streams, activation cleanup, an
  end-to-end write→read→edit scenario, SSE split-chunk parsing).

## [0.1.0] - 2026-06-15

Initial release.

### Added

- **The kernel** — seven primitives and nothing more: a hook bus (lifecycle
  events and filter hooks), a tool registry (register/shadow/dispose), a
  provider abstraction (request → stream of events), the agent loop (turns,
  streaming, guarded and ordered tool dispatch, steering and follow-up, stop
  conditions), a capability layer (grant/deny/ask, wildcards, audit log), the
  extension host (discovery, activation, the `ExtensionAPI`, hot reload via
  `jiti`), and the command registry (user-facing slash commands).
- **Providers** — `MockProvider`, a scriptable deterministic LLM that keeps the
  whole suite offline; and two real `fetch` + SSE clients with no SDK,
  `AnthropicProvider` (Messages API) and `OpenAIProvider` (Chat Completions and
  compatible endpoints), sharing retry/backoff and token-usage plumbing
  (`providers/http.ts`); retries cover 429/5xx/network errors.
- **Built-in extensions**, each riding the `ExtensionAPI`, capability-gated, and
  shipped with offline tests:
  - `core-tools` — `read`, `write`, `edit` (confined to a workspace root), `bash`.
  - `skills` — LLM-authored skills via `SKILL.md` with progressive disclosure.
  - `mcp` — a Model Context Protocol client over stdio and Streamable HTTP.
  - `codeact` — code-as-action execution in a subprocess boundary.
  - `subagents` — isolated child agents (single / parallel / chain).
  - `memory` — context compaction plus a `remember`/`recall` scratchpad.
  - `planmode` — a human-in-the-loop approval gate for mutating tools.
  - `session` — save / load / handoff for transcripts.
  - `packages` — install extensions from `path:` / `git:` / `npm:` sources.
  - `trace` — observability over the lifecycle events.
  - `context-files` — project context files injected into the prompt.

[Unreleased]: https://github.com/caohaotiantian/eagent/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/caohaotiantian/eagent/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/caohaotiantian/eagent/releases/tag/v0.1.0
