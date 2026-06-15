# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `self` extension — the agent authors and hot-loads its own TypeScript
  extensions at runtime (`write_extension`/`read_extension`/`reload_extension`),
  gated behind the `self:extend` capability. The Emacs ideal, realized.
- `limits` extension — resource guardrails (tool-output truncation, per-run
  tool-call budgets) implemented purely as hooks.
- `ExtensionAPI.loadExtension` / `unloadExtension` — load extensions at runtime
  through the host's tracked loader (enables dynamic and self-authored
  extensions as first-class citizens).
- Anthropic prompt caching (system + tools marked cacheable) and cache-token
  usage accounting.
- CLI `--json` mode (lifecycle events as JSONL on stdout, diagnostics on
  stderr) and `--help`/`--version`.
- A kernel-minimalism guard test that pins the public surface and a line
  ceiling on the core.

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

[Unreleased]: https://github.com/caohaotiantian/eagent/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/caohaotiantian/eagent/releases/tag/v0.1.0
