# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
