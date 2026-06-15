# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
  whole suite offline; and `AnthropicProvider`, a real Messages-API client over
  `fetch` and SSE with retries on 429/5xx/network errors and token-usage
  accounting (no SDK, no extra dependency).
- **Built-in extensions**, each riding the `ExtensionAPI`, capability-gated, and
  shipped with offline tests:
  - `core-tools` — `read`, `write`, `edit`, `bash`.
  - `skills` — LLM-authored skills via `SKILL.md` with progressive disclosure.
  - `mcp` — a Model Context Protocol client over stdio.
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
